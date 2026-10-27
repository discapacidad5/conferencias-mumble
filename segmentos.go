package main

// ============================================================================
// ALMACÉN DE SEGMENTOS DE VOZ (historial confiable estilo nota de voz)
// ============================================================================
//
// Cada intervención hablada (una "nota de voz") se guarda como un archivo
// independiente en $DATA_DIR/audio/<sala>/seg-XXXXXXXX.seg con un número de
// secuencia global por sala. Los clientes lo reproducen en vivo mientras se
// graba (WebSocket push, igual que antes) y, si pierden tramas por micro-cortes
// o desconexión, lo descargan completo por HTTP GET (pull, con Range resumible).
//
// Formato de archivo (big-endian):
//   magic "CSEG" + u8 ver
//   u32 seq, u8 grupo, u8 flags (bit0 = interrumpida)
//   u16 len(de) + de, u16 len(nombre) + nombre
//   i64 inicioMs, u32 durMs, u32 numFrames
//   registros: [u16 len][payload tal cual llegó por el WS: rateCode+seq+datos]
//
// Retención: 1 hora por sala (los micro-cortes se reparan con ~1 min; la hora
// cubre a quien entra tarde). Los archivos viejos se borran solos — el
// historial persistente vive en el IndexedDB de cada cliente.

import (
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	segRetencionMs  = int64(3600_000) // 1 h en el servidor
	segMaxDurMs     = int64(90_000)   // subdivide intervenciones muy largas
	segIdleCierreMs = int64(1600)     // sin tramas -> frase cerrada
	segMaxBytesSala = int64(64 << 20) // tope defensivo por sala
	segMagic        = "CSEG"
	segVer          = 1
)

type segmento struct {
	Seq      uint32 `json:"seq"`
	Grupo    int    `json:"g"`
	De       string `json:"de"`
	Nombre   string `json:"nombre"`
	Inicio   int64  `json:"inicio"`
	DurMs    int64  `json:"durMs"`
	Bytes    int    `json:"bytes"`
	Abierto  bool   `json:"abierto"`
	Cortado  bool   `json:"interrumpida,omitempty"`
	ruta     string
	frames   [][]byte // solo mientras Abierto
	ultFrame int64    // unix ms de la última trama recibida
}

type segStore struct {
	mu       sync.Mutex
	sala     string
	proxSeq  uint32
	abiertos map[string]*segmento // identidad -> segmento abierto
	cerrados []*segmento          // ordenados por seq
	dir      string
	mr       *mediaRoom
}

func nuevoSegStore(sala string, mr *mediaRoom) *segStore {
	s := &segStore{
		sala:     sala,
		proxSeq:  1,
		abiertos: map[string]*segmento{},
		dir:      filepath.Join(dataDir, "audio", sala),
		mr:       mr,
	}
	os.MkdirAll(s.dir, 0o755)
	s.cargarIndice()
	return s
}

// cargarIndice reconstruye el manifiesto al arrancar leyendo las cabeceras de
// los archivos existentes (y purga los que ya pasaron de la hora).
func (s *segStore) cargarIndice() {
	ents, err := os.ReadDir(s.dir)
	if err != nil {
		return
	}
	limite := ahora() - segRetencionMs
	for _, en := range ents {
		nom := en.Name()
		if !strings.HasPrefix(nom, "seg-") || !strings.HasSuffix(nom, ".seg") {
			continue
		}
		p := filepath.Join(s.dir, nom)
		sg := leerCabeceraSeg(p)
		if sg == nil {
			continue
		}
		sg.ruta = p
		if sg.Inicio < limite {
			os.Remove(p)
			continue
		}
		if st, err := en.Info(); err == nil {
			sg.Bytes = int(st.Size())
		}
		s.cerrados = append(s.cerrados, sg)
		if sg.Seq >= s.proxSeq {
			s.proxSeq = sg.Seq + 1
		}
	}
	sort.Slice(s.cerrados, func(i, j int) bool { return s.cerrados[i].Seq < s.cerrados[j].Seq })
}

// leerCabeceraSeg parsea solo la cabecera fija de un archivo de segmento.
func leerCabeceraSeg(p string) *segmento {
	f, err := os.Open(p)
	if err != nil {
		return nil
	}
	defer f.Close()
	var hdr [5]byte
	if _, err := io.ReadFull(f, hdr[:]); err != nil || string(hdr[:4]) != segMagic || hdr[4] != segVer {
		return nil
	}
	var f4 [4]byte
	if _, err := io.ReadFull(f, f4[:]); err != nil {
		return nil
	}
	sg := &segmento{Seq: binary.BigEndian.Uint32(f4[:])}
	var g2 [2]byte
	if _, err := io.ReadFull(f, g2[:]); err != nil {
		return nil
	}
	sg.Grupo = int(g2[0])
	sg.Cortado = g2[1]&1 != 0
	leerStr := func() string {
		var lb [2]byte
		if _, err := io.ReadFull(f, lb[:]); err != nil {
			return ""
		}
		n := int(binary.BigEndian.Uint16(lb[:]))
		if n <= 0 || n > 1024 {
			return ""
		}
		b := make([]byte, n)
		if _, err := io.ReadFull(f, b); err != nil {
			return ""
		}
		return string(b)
	}
	sg.De = leerStr()
	sg.Nombre = leerStr()
	var resto [16]byte
	if _, err := io.ReadFull(f, resto[:]); err != nil {
		return nil
	}
	sg.Inicio = int64(binary.BigEndian.Uint64(resto[0:8]))
	sg.DurMs = int64(binary.BigEndian.Uint32(resto[8:12]))
	return sg
}

// appendFrame acumula una trama de voz en el segmento abierto del hablante.
// Devuelve (segmentoNuevo, segmentoCerrado) para notificar por ctrl.
func (s *segStore) appendFrame(id, nombre string, grupo int, payload []byte, forceEOS bool) (nuevo *segmento, cerrado *segmento) {
	rc := payload[0]
	s.mu.Lock()
	defer s.mu.Unlock()

	sg := s.abiertos[id]
	if rc == 0 || forceEOS {
		// EOS: el hablante soltó la frase
		if sg != nil {
			cerrado = s.cerrarSeg(sg, false)
		}
		return nil, cerrado
	}

	if sg == nil {
		sg = &segmento{
			Seq:      s.proxSeq,
			Grupo:    grupo,
			De:       id,
			Nombre:   nombre,
			Inicio:   ahora(),
			Abierto:  true,
			ultFrame: ahora(),
		}
		s.proxSeq++
		s.abiertos[id] = sg
		nuevo = sg
	}
	cp := make([]byte, len(payload))
	copy(cp, payload)
	sg.frames = append(sg.frames, cp)
	sg.Bytes += len(cp) + 2
	sg.DurMs = ahora() - sg.Inicio
	sg.ultFrame = ahora()

	// Intervención muy larga (PTT olvidado): cortar a 90 s y seguir en una nueva
	if sg.DurMs >= segMaxDurMs {
		cerrado = s.cerrarSeg(sg, false)
	}
	return nuevo, cerrado
}

// cerrarSeg escribe el archivo definitivo, lo mueve al historial y libera RAM.
// Debe llamarse con s.mu tomado.
func (s *segStore) cerrarSeg(sg *segmento, interrumpida bool) *segmento {
	delete(s.abiertos, sg.De)
	sg.Abierto = false
	sg.Cortado = sg.Cortado || interrumpida
	if sg.DurMs <= 0 {
		sg.DurMs = ahora() - sg.Inicio
	}
	ruta := filepath.Join(s.dir, "seg-"+itoa8(sg.Seq)+".seg")
	tmp := ruta + ".tmp"
	if escribirArchivoSeg(tmp, sg) == nil {
		os.Rename(tmp, ruta)
		sg.ruta = ruta
		if st, err := os.Stat(ruta); err == nil {
			sg.Bytes = int(st.Size())
		}
		s.cerrados = append(s.cerrados, sg)
	} else {
		os.Remove(tmp)
	}
	sg.frames = nil
	return sg
}

// cerrarHablante cierra el segmento abierto de un hablante (al soltar el piso,
// desconectarse o ser interrumpido).
func (s *segStore) cerrarHablante(id string, interrumpida bool) *segmento {
	s.mu.Lock()
	defer s.mu.Unlock()
	sg := s.abiertos[id]
	if sg == nil {
		return nil
	}
	return s.cerrarSeg(sg, interrumpida)
}

// ultimoCerrado devuelve el seq más alto ya cerrado (0 si no hay).
func (s *segStore) ultimoCerrado() uint32 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if n := len(s.cerrados); n > 0 {
		return s.cerrados[n-1].Seq
	}
	return 0
}

// tick: barre segmentos abiertos inactivos (>1,6 s sin tramas) y purga el
// historial de más de 1 hora (y el exceso de bytes por sala).
func (s *segStore) tick() {
	var cerrados []*segmento
	s.mu.Lock()
	ahoraMs := ahora()
	for id, sg := range s.abiertos {
		if ahoraMs-sg.ultFrame > segIdleCierreMs {
			cerrados = append(cerrados, s.cerrarSeg(sg, false))
		}
		_ = id
	}
	// purga por antigüedad + tope de bytes por sala
	limite := ahoraMs - segRetencionMs
	total := int64(0)
	for _, c := range s.cerrados {
		total += int64(c.Bytes)
	}
	keep := s.cerrados[:0]
	for _, c := range s.cerrados {
		expirado := c.Inicio < limite
		if !expirado && total > segMaxBytesSala {
			total -= int64(c.Bytes)
			expirado = true
		}
		if expirado {
			if c.ruta != "" {
				os.Remove(c.ruta)
			}
			continue
		}
		keep = append(keep, c)
	}
	s.cerrados = keep
	s.mu.Unlock()

	for _, sg := range cerrados {
		s.mr.notificarSegFin(sg)
	}
}

// manifiesto lista los segmentos cerrados (y el abierto) del grupo desde seq N.
func (s *segStore) manifiesto(desde uint32, grupo int) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []any{}
	for _, c := range s.cerrados {
		if c.Seq >= desde && c.Grupo == grupo {
			out = append(out, c)
		}
	}
	var abierto *segmento
	for _, a := range s.abiertos {
		if a.Grupo == grupo {
			abierto = a // con piso único solo hay uno abierto por grupo
		}
	}
	return map[string]any{
		"segmentos": out,
		"ultimo":    s.proxSeq - 1,
		"abierto":   abierto,
	}
}

// buscar devuelve un segmento por seq (abierto o cerrado).
func (s *segStore) buscar(seq uint32) *segmento {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, a := range s.abiertos {
		if a.Seq == seq {
			return a
		}
	}
	i := sort.Search(len(s.cerrados), func(i int) bool { return s.cerrados[i].Seq >= seq })
	if i < len(s.cerrados) && s.cerrados[i].Seq == seq {
		return s.cerrados[i]
	}
	return nil
}

func itoa8(v uint32) string {
	b := []byte("00000000")
	for i := 7; i >= 0; i-- {
		b[i] = byte('0' + v%10)
		v /= 10
	}
	return string(b)
}

// escribirArchivoSeg vuelca cabecera + tramas de un segmento a disco.
func escribirArchivoSeg(ruta string, sg *segmento) error {
	f, err := os.Create(ruta)
	if err != nil {
		return err
	}
	defer f.Close()
	w := func(b []byte) error { _, err := f.Write(b); return err }

	hdr := make([]byte, 0, 32+len(sg.De)+len(sg.Nombre))
	hdr = append(hdr, segMagic...)
	hdr = append(hdr, segVer)
	var f4 [4]byte
	binary.BigEndian.PutUint32(f4[:], sg.Seq)
	hdr = append(hdr, f4[:]...)
	flags := byte(0)
	if sg.Cortado {
		flags |= 1
	}
	hdr = append(hdr, byte(sg.Grupo), flags)
	putStr := func(t string) {
		var lb [2]byte
		binary.BigEndian.PutUint16(lb[:], uint16(len(t)))
		hdr = append(hdr, lb[:]...)
		hdr = append(hdr, t...)
	}
	putStr(sg.De)
	putStr(sg.Nombre)
	var resto [16]byte
	binary.BigEndian.PutUint64(resto[0:8], uint64(sg.Inicio))
	binary.BigEndian.PutUint32(resto[8:12], uint32(sg.DurMs))
	binary.BigEndian.PutUint32(resto[12:16], uint32(len(sg.frames)))
	hdr = append(hdr, resto[:]...)
	if err := w(hdr); err != nil {
		return err
	}
	var lb [2]byte
	for _, fr := range sg.frames {
		binary.BigEndian.PutUint16(lb[:], uint16(len(fr)))
		if err := w(lb[:]); err != nil {
			return err
		}
		if err := w(fr); err != nil {
			return err
		}
	}
	return nil
}

// serializarAbierto vuelca las tramas actuales de un segmento ABIERTO en el
// mismo formato de archivo (cabecera con durMs parcial) para descarga en vivo.
func serializarAbierto(sg *segmento) []byte {
	out := make([]byte, 0, sg.Bytes+64)
	hdr := make([]byte, 0, 64)
	hdr = append(hdr, segMagic...)
	hdr = append(hdr, segVer)
	var f4 [4]byte
	binary.BigEndian.PutUint32(f4[:], sg.Seq)
	hdr = append(hdr, f4[:]...)
	flags := byte(2) // bit1 = aún abierto
	hdr = append(hdr, byte(sg.Grupo), flags)
	putStr := func(t string) {
		var lb [2]byte
		binary.BigEndian.PutUint16(lb[:], uint16(len(t)))
		hdr = append(hdr, lb[:]...)
		hdr = append(hdr, t...)
	}
	putStr(sg.De)
	putStr(sg.Nombre)
	var resto [16]byte
	binary.BigEndian.PutUint64(resto[0:8], uint64(sg.Inicio))
	binary.BigEndian.PutUint32(resto[8:12], uint32(sg.DurMs))
	binary.BigEndian.PutUint32(resto[12:16], uint32(len(sg.frames)))
	hdr = append(hdr, resto[:]...)
	out = append(out, hdr...)
	var lb [2]byte
	for _, fr := range sg.frames {
		binary.BigEndian.PutUint16(lb[:], uint16(len(fr)))
		out = append(out, lb[:]...)
		out = append(out, fr...)
	}
	return out
}

// parsearArchivoSeg lee un archivo de segmento completo (cabecera + tramas).
// Lo usa el cliente implícitamente; esta función sirve para tests internos.
func parsearArchivoSeg(b []byte) (*segmento, [][]byte, bool) {
	if len(b) < 21 || string(b[:4]) != segMagic || b[4] != segVer {
		return nil, nil, false
	}
	sg := &segmento{Seq: binary.BigEndian.Uint32(b[5:9]), Grupo: int(b[9]), Cortado: b[10]&1 != 0, Abierto: b[10]&2 != 0}
	i := 11
	leerStr := func() (string, bool) {
		if i+2 > len(b) {
			return "", false
		}
		n := int(binary.BigEndian.Uint16(b[i : i+2]))
		i += 2
		if i+n > len(b) {
			return "", false
		}
		s := string(b[i : i+n])
		i += n
		return s, true
	}
	var ok bool
	if sg.De, ok = leerStr(); !ok {
		return nil, nil, false
	}
	if sg.Nombre, ok = leerStr(); !ok {
		return nil, nil, false
	}
	if i+16 > len(b) {
		return nil, nil, false
	}
	sg.Inicio = int64(binary.BigEndian.Uint64(b[i : i+8]))
	sg.DurMs = int64(binary.BigEndian.Uint32(b[i+8 : i+12]))
	nf := int(binary.BigEndian.Uint32(b[i+12 : i+16]))
	i += 16
	frames := make([][]byte, 0, nf)
	for k := 0; k < nf; k++ {
		if i+2 > len(b) {
			break
		}
		n := int(binary.BigEndian.Uint16(b[i : i+2]))
		i += 2
		if i+n > len(b) {
			break
		}
		frames = append(frames, b[i:i+n])
		i += n
	}
	return sg, frames, true
}

// ============================================================================
// NOTIFICACIONES Y HANDLERS HTTP
// ============================================================================

// notificarSegIni / notificarSegFin avisan por el canal de control del WS a
// todos los clientes del grupo del segmento.
func (s *segStore) notificarSegIni(sg *segmento) {
	msg, _ := json.Marshal(map[string]any{
		"t": "seg_ini", "seq": sg.Seq, "de": sg.De, "nombre": sg.Nombre, "g": sg.Grupo,
	})
	s.mr.enviarCtrlGrupo(sg.Grupo, append([]byte{1}, msg...))
}

func (r *mediaRoom) notificarSegFin(sg *segmento) {
	msg, _ := json.Marshal(map[string]any{
		"t": "seg_fin", "seq": sg.Seq, "de": sg.De, "nombre": sg.Nombre, "g": sg.Grupo,
		"durMs": sg.DurMs, "bytes": sg.Bytes, "interrumpida": sg.Cortado,
	})
	r.enviarCtrlGrupo(sg.Grupo, append([]byte{1}, msg...))
}

// enviarCtrlGrupo manda un mensaje de control a todos los clientes de un grupo.
func (r *mediaRoom) enviarCtrlGrupo(grupo int, raw []byte) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, c := range r.clientes {
		if c.grupo == grupo {
			c.enviarCtrl(raw)
		}
	}
}

// hAudioManifiesto atiende GET /api/salas/{sala}/audio?desde=N&g=G
func hAudioManifiesto(w http.ResponseWriter, r *http.Request, cl *Claims) {
	sala := r.PathValue("sala")
	mr := media.room(sala)
	desde := uint32(0)
	if v := r.URL.Query().Get("desde"); v != "" {
		if n, err := strconv.ParseUint(v, 10, 32); err == nil {
			desde = uint32(n)
		}
	}
	grupo := cl.Grupo
	if v := r.URL.Query().Get("g"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			grupo = n
		}
	}
	escribirJSON(w, 200, mr.seg.manifiesto(desde, grupo))
}

// hAudioSegmento atiende GET /api/salas/{sala}/audio/{seq}
// Segmento cerrado → sirve el archivo con soporte Range (descarga resumible).
// Segmento abierto → snapshot en memoria del audio recibido hasta ahora.
func hAudioSegmento(w http.ResponseWriter, r *http.Request, cl *Claims) {
	sala := r.PathValue("sala")
	seq, err := strconv.ParseUint(r.PathValue("seq"), 10, 32)
	if err != nil {
		escribirJSON(w, 400, map[string]string{"error": "seq inválido"})
		return
	}
	sg := media.room(sala).seg.buscar(uint32(seq))
	if sg == nil {
		escribirJSON(w, 404, map[string]string{"error": "segmento no encontrado"})
		return
	}
	if sg.Abierto {
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(serializarAbierto(sg))
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	http.ServeFile(w, r, sg.ruta)
}

// barrerSegmentos corre cada segundo: cierra frases sin EOS (WiFi muerto a
// media palabra) y purga el historial de más de 1 hora.
func barrerSegmentos() {
	for {
		time.Sleep(1 * time.Second)
		media.mu.Lock()
		rooms := make([]*mediaRoom, 0, len(media.rooms))
		for _, r := range media.rooms {
			rooms = append(rooms, r)
		}
		media.mu.Unlock()
		for _, r := range rooms {
			r.seg.tick()
		}
	}
}

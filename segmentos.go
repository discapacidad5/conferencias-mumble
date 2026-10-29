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
	"fmt"
	"io"
	"log"
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
	segMaxDurMs     = int64(180_000)  // subdivide intervenciones muy largas (3 min)
	segIdleCierreMs = int64(45_000)   // baches móviles de hasta 45 s no parten la frase (soltar PTT cierra al instante por EOS/piso_soltar)
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
	frames   [][]byte // solo mientras Abierto o reparable
	ultFrame int64    // unix ms de la última trama recibida
	// Anti-pérdida emisor->servidor: cada audio lleva su propio identificador
	// aid (4 bits altos de tx: 1..15) y su contador de trama desde 0 (12 bits
	// bajos: 0..4095). Al soltar el PTT y volver a pisar cambia aid y la
	// trama vuelve a 0, separando sin ambigüedad el audio viejo del nuevo.
	aid           uint8               // identificador de audio del emisor (1..15)
	vistos        map[uint32]struct{} // (tx<<1 | familia) ya archivados
	porTx         map[uint32][]byte   // (tx<<1 | familia) -> payload retenido hasta estar en secuencia
	faltan        map[uint16]struct{} // txs detectados como perdidos
	faltaDesde    map[uint16]int64    // cuándo se detectó cada faltante (el vivo espera máx ~4 s)
	ackOk         bool                // ya se confirmó al emisor la recepción completa
	ultTx         uint16              // tx más alto visto en este aid
	proxEnvTx     uint16              // siguiente tx que toca liberar en secuencia hacia los oyentes
	tieneTx       bool                // ya llegó al menos una trama numerada
	ultFalta      int64               // último aviso "falta" enviado al emisor
	reparaH       int64               // >0: cerrado pero reparable hasta este instante
	eosVisto      bool                // cerrado por EOS del emisor (no por corte)
	ultChunkNotif int64               // último aviso 'chunk' enviado (rate-limit ~400 ms)
}

type segStore struct {
	mu        sync.Mutex
	sala      string
	proxSeq   uint32
	abiertos  map[string]*segmento // identidad -> segmento abierto
	cerrados  []*segmento          // ordenados por seq
	recientes []*segmento          // cerrados aún reparables (rellenan huecos)
	dir       string
	mr        *mediaRoom
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

// txDeTrama lee la etiqueta de 16 bits del emisor (payload[1:3] little-endian):
// 4 bits altos = aid (identificador de audio 1..15), 12 bits bajos = idx (trama desde 0).
func txDeTrama(b []byte) uint16 {
	if len(b) < 3 {
		return 0
	}
	return binary.LittleEndian.Uint16(b[1:3])
}

func aidDeTx(tx uint16) uint8 {
	return uint8((tx >> 12) & 0x0f)
}

func idxDeTx(tx uint16) uint16 {
	return tx & 0x0fff
}

func armarTx(aid uint8, idx uint16) uint16 {
	return (uint16(aid&0x0f) << 12) | (idx & 0x0fff)
}

// txFamilia distingue las dos variantes del mismo bloque de voz (Opus /
// respaldo ADPCM): comparten tx pero ambas se archivan para los oyentes
// sin decodificador Opus. El dedup y el orden son por tx; la familia solo
// evita descartar la variante hermana.
func txFamilia(rc byte) uint32 {
	if rc >= 10 && rc <= 19 {
		return 0 // Opus
	}
	return 1 // ADPCM / µ-law
}

// durDeTramas estima la duración real en ms a partir de los números tx
// únicos archivados (cada tx = 40 ms de voz), para que una frase enviada
// en ráfaga tras un micro-corte conserve su duración verdadera y no se
// descarte por haber llegado en pocos milisegundos de reloj.
func durDeTramas(sg *segmento) int64 {
	if len(sg.vistos) > 0 {
		txs := map[uint32]struct{}{}
		for k := range sg.vistos {
			txs[k>>1] = struct{}{}
		}
		return int64(len(txs)) * 40
	}
	return int64(len(sg.frames)) * 40
}

// insertarTrama añade una trama al segmento ordenada por su índice de trama
// dentro del audio (0, 1, 2...): una retransmisión tardía rellena su hueco.
func insertarTrama(sg *segmento, tx uint16, tieneTx bool, cp []byte) {
	ins := len(sg.frames)
	if tieneTx {
		idx := int(idxDeTx(tx))
		for ins > 0 && ((int(idxDeTx(txDeTrama(sg.frames[ins-1])))-idx)&0x0fff) < 2048 {
			ins--
		}
	}
	sg.frames = append(sg.frames, nil)
	copy(sg.frames[ins+1:], sg.frames[ins:])
	sg.frames[ins] = cp
}

// marcarHuecos registra como perdidas las tramas del mismo audio (sg.aid)
// entre ultIdx y idx (y desde 0 si la primera trama llegó con idx > 0).
func marcarHuecos(sg *segmento, tx uint16) []uint16 {
	idx := int(idxDeTx(tx))
	var nuevos []uint16
	if sg.faltaDesde == nil {
		sg.faltaDesde = map[uint16]int64{}
	}
	if !sg.tieneTx {
		// Primera trama vista de este audio: debería ser idx == 0. Si llegó
		// idx > 0, se perdieron las tramas iniciales 0..idx-1.
		for k := 0; k < idx && k < 64; k++ {
			miss := armarTx(sg.aid, uint16(k))
			if _, ok := sg.faltan[miss]; !ok {
				sg.faltan[miss] = struct{}{}
				sg.faltaDesde[miss] = ahora()
				nuevos = append(nuevos, miss)
			}
		}
		return nuevos
	}
	ultIdx := int(idxDeTx(sg.ultTx))
	diff := (idx - ultIdx) & 0x0fff
	if diff <= 1 || diff >= 2048 {
		return nil
	}
	for k := 1; k < diff && k <= 64; k++ {
		miss := armarTx(sg.aid, uint16((ultIdx+k)&0x0fff))
		if _, ok := sg.faltan[miss]; !ok {
			sg.faltan[miss] = struct{}{}
			sg.faltaDesde[miss] = ahora()
			nuevos = append(nuevos, miss)
		}
	}
	return nuevos
}

// drenarContiguos extrae en orden estricto todas las tramas consecutivas
// desde sg.proxEnvTx (empezando en idx=0) que ya estén completas. Si falta
// sg.proxEnvTx, se detiene y retiene las posteriores hasta que llegue.
func drenarContiguos(sg *segmento) [][]byte {
	if !sg.tieneTx {
		return nil
	}
	var listos [][]byte
	ultIdx := int(idxDeTx(sg.ultTx))
	for {
		tx := sg.proxEnvTx
		idx := int(idxDeTx(tx))
		if _, falta := sg.faltan[tx]; falta {
			if sg.faltaDesde == nil || ahora()-sg.faltaDesde[tx] < 1200 {
				break // pieza faltante reciente: esperarla antes de soltar
			}
			// >1.2 s sin llegar: el vivo avanza con un salto mínimo en vez de
			// congelarse — la pieza SIGUE pidiéndose y cuando llegue completa
			// la grabación del archivo vía reparar()
		}
		b0, ok0 := sg.porTx[uint32(tx)<<1|0]
		b1, ok1 := sg.porTx[uint32(tx)<<1|1]
		if !ok0 && !ok1 {
			if ((ultIdx-idx)&0x0fff) >= 2048 || idx == ultIdx {
				break
			}
		}
		if ok0 {
			listos = append(listos, b0)
			delete(sg.porTx, uint32(tx)<<1|0)
		}
		if ok1 {
			listos = append(listos, b1)
			delete(sg.porTx, uint32(tx)<<1|1)
		}
		if idx == ultIdx && !ok0 && !ok1 {
			break
		}
		sg.proxEnvTx = armarTx(sg.aid, uint16((idx+1)&0x0fff))
		if ((ultIdx - idx) & 0x0fff) == 0 {
			break
		}
	}
	return listos
}

// appendFrame acumula una trama de voz en el segmento abierto del hablante y
// devuelve solo las tramas que ya están en secuencia completa sin huecos
// (listos) para reenviar a los oyentes, además de los txs faltantes.
func (s *segStore) appendFrame(id, nombre string, grupo int, payload []byte, forceEOS bool) (nuevo *segmento, cerrado *segmento, faltan []uint16, listos [][]byte) {
	rc := payload[0]
	tieneTx := len(payload) >= 3
	var tx uint16
	var aid uint8
	if tieneTx {
		tx = txDeTrama(payload)
		aid = aidDeTx(tx)
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	sg := s.abiertos[id]
	if rc == 0 || forceEOS {
		// EOS: el hablante soltó la frase. Si el EOS saltó sobre tramas que
		// nunca llegaron, se marcan: el segmento queda reparable y se piden.
		if sg != nil && (!tieneTx || aid == 0 || sg.aid == 0 || sg.aid == aid) {
			if tieneTx {
				faltan = marcarHuecos(sg, tx)
			}
			listos = drenarContiguos(sg)
			if len(sg.faltan) > 0 && len(faltan) == 0 {
				for t := range sg.faltan {
					faltan = append(faltan, t)
					if len(faltan) >= 64 {
						break
					}
				}
			}
			sg.eosVisto = true
			cp := make([]byte, len(payload))
			copy(cp, payload)
			listos = append(listos, cp)
			cerrado = s.cerrarSeg(sg, false)
		}
		return nil, cerrado, faltan, listos
	}

	// Si el emisor cambió el identificador de audio (soltó el PTT y empezó
	// un audio nuevo aid=2 desde idx=0), cerramos el audio anterior aid=1
	// (que queda en s.recientes para recibir las piezas que aún le falten)
	// y abrimos inmediatamente el segmento nuevo para aid=2.
	if sg != nil && tieneTx && aid != 0 && sg.aid != 0 && sg.aid != aid {
		cerrado = s.cerrarSeg(sg, false)
		sg = nil
	}

	if sg == nil {
		sg = &segmento{
			Seq:        s.proxSeq,
			Grupo:      grupo,
			De:         id,
			Nombre:     nombre,
			Inicio:     ahora(),
			Abierto:    true,
			ultFrame:   ahora(),
			aid:        aid,
			vistos:     map[uint32]struct{}{},
			porTx:      map[uint32][]byte{},
			faltan:     map[uint16]struct{}{},
			faltaDesde: map[uint16]int64{},
			ultTx:      armarTx(aid, 0),
			proxEnvTx:  armarTx(aid, 0),
			tieneTx:    false,
		}
		s.proxSeq++
		s.abiertos[id] = sg
		nuevo = sg
	}

	cp := make([]byte, len(payload))
	copy(cp, payload)

	if tieneTx {
		if sg.aid == 0 && aid != 0 {
			sg.aid = aid
			sg.proxEnvTx = armarTx(aid, 0)
		}
		key := uint32(tx)<<1 | txFamilia(rc)
		if _, dup := sg.vistos[key]; dup {
			return nuevo, cerrado, nil, nil // retransmisión de algo ya archivado
		}
		sg.vistos[key] = struct{}{}
		sg.porTx[key] = cp
		faltan = marcarHuecos(sg, tx)
		if !sg.tieneTx || ((int(idxDeTx(tx))-int(idxDeTx(sg.ultTx)))&0x0fff) < 2048 {
			sg.ultTx = tx
		}
		sg.tieneTx = true
		delete(sg.faltan, tx)
		// Si sigue habiendo huecos sin rellenar >600 ms, volver a pedirlos
		// de inmediato al emisor hasta que no falte ni una pieza
		if len(sg.faltan) > 0 && ahora()-sg.ultFalta > 600 {
			sg.ultFalta = ahora()
			for t := range sg.faltan {
				if len(faltan) >= 64 {
					break
				}
				ya := false
				for _, u := range faltan {
					if u == t {
						ya = true
						break
					}
				}
				if !ya {
					faltan = append(faltan, t)
				}
			}
		}
		listos = drenarContiguos(sg)
	} else {
		listos = [][]byte{cp}
	}

	insertarTrama(sg, tx, tieneTx, cp)
	sg.Bytes += len(cp) + 2
	sg.DurMs = ahora() - sg.Inicio
	if d := durDeTramas(sg); d > sg.DurMs {
		sg.DurMs = d
	}
	sg.ultFrame = ahora()

	// Intervención muy larga: cortar a 3 min y seguir en una nueva
	if sg.DurMs >= segMaxDurMs {
		cerrado = s.cerrarSeg(sg, false)
	}
	return nuevo, cerrado, faltan, listos
}

// reparar encaja una trama en un segmento YA cerrado que tenga el MISMO
// identificador de audio (sg.aid == aid): rellena sus huecos o agrega las
// tramas finales rezagadas de ese aid mientras el emisor ya habla el
// siguiente aid, reescribe su archivo y devuelve las tramas destrabadas.
func (s *segStore) reparar(id string, payload []byte) (*segmento, [][]byte) {
	if len(payload) < 3 {
		return nil, nil
	}
	rc := payload[0]
	tx := txDeTrama(payload)
	aid := aidDeTx(tx)
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, sg := range s.recientes {
		if sg.De != id {
			continue
		}
		if aid != 0 && sg.aid != 0 && sg.aid != aid {
			continue
		}
		if rc == 0 {
			if aid != 0 && sg.aid == aid && !sg.eosVisto {
				marcarHuecos(sg, tx)
				sg.eosVisto = true
				return sg, drenarContiguos(sg)
			}
			continue
		}
		_, eraFalta := sg.faltan[tx]
		// Toda trama del MISMO aid de este segmento es una pieza real de la
		// grabación — se acepta aunque el EOS ya haya llegado (el vivo pudo
		// haber saltado el hueco por el límite de 4 s, pero el archivo debe
		// quedar completo) o aunque no esté en faltan (cola rezagada).
		mismoAudio := aid != 0 && sg.aid == aid
		if !eraFalta && !mismoAudio {
			continue
		}
		key := uint32(tx)<<1 | txFamilia(rc)
		if _, dup := sg.vistos[key]; dup {
			return sg, nil
		}
		cp := make([]byte, len(payload))
		copy(cp, payload)
		sg.vistos[key] = struct{}{}
		if sg.porTx != nil {
			sg.porTx[key] = cp
		}
		marcarHuecos(sg, tx)
		if !sg.tieneTx || ((int(idxDeTx(tx))-int(idxDeTx(sg.ultTx)))&0x0fff) < 2048 {
			sg.ultTx = tx
		}
		sg.tieneTx = true
		delete(sg.faltan, tx)
		insertarTrama(sg, tx, true, cp)
		sg.Bytes += len(cp) + 2
		if d := durDeTramas(sg); d > sg.DurMs {
			sg.DurMs = d
		}
		sg.ultFrame = ahora()
		sg.reparaH = ahora() + 45_000
		listos := drenarContiguos(sg)
		if sg.ruta == "" && sg.DurMs >= 700 {
			sg.ruta = filepath.Join(s.dir, "seg-"+itoa8(sg.Seq)+".seg")
			s.cerrados = append(s.cerrados, sg)
		}
		if sg.ruta != "" {
			tmp := sg.ruta + ".tmp"
			if escribirArchivoSeg(tmp, sg) == nil {
				_ = os.Rename(tmp, sg.ruta)
				if st, err := os.Stat(sg.ruta); err == nil {
					sg.Bytes = int(st.Size())
				}
			} else {
				os.Remove(tmp)
			}
		}
		return sg, listos
	}
	return nil, nil
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
	if d := durDeTramas(sg); d > sg.DurMs {
		sg.DurMs = d
	}
	// tap accidental del PTT: notas de <0,7 s no se archivan ni entran al
	// manifiesto (el cliente igual recibe seg_fin y borra la nota en vivo)
	if sg.DurMs < 700 {
		if sg.aid != 0 && !sg.eosVisto {
			sg.reparaH = ahora() + 45_000
			s.recientes = append(s.recientes, sg)
		} else {
			sg.frames, sg.vistos, sg.porTx, sg.faltan, sg.faltaDesde = nil, nil, nil, nil, nil
		}
		return sg
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
	// Queda reparable ~45 s si tiene huecos o si cerró antes de llegar su
	// EOS (tramas con el mismo sg.aid aún en camino desde el celular)
	if len(sg.faltan) > 0 || (sg.aid != 0 && !sg.eosVisto) {
		sg.reparaH = ahora() + 45_000
		s.recientes = append(s.recientes, sg)
		for len(s.recientes) > 8 {
			viejo := s.recientes[0]
			s.recientes = s.recientes[1:]
			viejo.frames, viejo.vistos, viejo.porTx, viejo.faltan, viejo.faltaDesde = nil, nil, nil, nil, nil
		}
	} else {
		sg.frames, sg.vistos, sg.porTx, sg.faltan, sg.faltaDesde = nil, nil, nil, nil, nil
	}
	return sg
}

// cerrarHablante cierra el segmento abierto de un hablante (al soltar el piso,
// desconectarse o ser interrumpido).
func (s *segStore) cerrarHablante(id string, interrumpida bool) *segmento {
	return s.cerrarHablanteAid(id, 0, interrumpida)
}

// cerrarHablanteAid cierra el segmento abierto del hablante solo si coincide
// con aid (o si aid == 0); si el segmento abierto ya pertenece a un aid nuevo
// (p.ej. aid=2 cuando llega tarde el piso_soltar de aid=1), no cierra aid=2.
func (s *segStore) cerrarHablanteAid(id string, aid uint8, interrumpida bool) *segmento {
	s.mu.Lock()
	defer s.mu.Unlock()
	sg := s.abiertos[id]
	if sg == nil {
		return nil
	}
	if aid != 0 && sg.aid != 0 && sg.aid != aid {
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
	var incompletos []*segmento
	s.mu.Lock()
	ahoraMs := ahora()
	for id, sg := range s.abiertos {
		if ahoraMs-sg.ultFrame > segIdleCierreMs {
			cerrados = append(cerrados, s.cerrarSeg(sg, false))
		} else if len(sg.faltan) > 0 {
			incompletos = append(incompletos, sg)
		}
		_ = id
	}
	// reparables vencidos o ya completos: liberan sus tramas de RAM
	if len(s.recientes) > 0 {
		vivos := s.recientes[:0]
		for _, sg := range s.recientes {
			if sg.reparaH > ahoraMs && (len(sg.faltan) > 0 || (sg.aid != 0 && !sg.eosVisto)) {
				vivos = append(vivos, sg)
				if len(sg.faltan) > 0 {
					incompletos = append(incompletos, sg)
				}
			} else {
				sg.frames, sg.vistos, sg.porTx, sg.faltan, sg.faltaDesde = nil, nil, nil, nil, nil
			}
		}
		s.recientes = vivos
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
		s.pedirFaltantes(sg) // frase cerrada por inactividad con huecos
	}
	for _, sg := range incompletos {
		s.pedirFaltantes(sg) // reintento periódico hasta que llegue el 100%
	}
}

// manifiesto lista los segmentos cerrados (y el abierto) del grupo desde
// seq N. limite>0 recorta la lista a los últimos N — para la siembra del
// chat al entrar no hace falta bajar el historial entero de la hora.
func (s *segStore) manifiesto(desde uint32, grupo int, limite int) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []any{}
	for _, c := range s.cerrados {
		if c.Seq >= desde && c.Grupo == grupo {
			out = append(out, c)
		}
	}
	if limite > 0 && len(out) > limite {
		out = out[len(out)-limite:]
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

// pedirFaltantes avisa al EMISOR de los txs que faltan en un segmento:
// anti-pérdida simétrica — igual que el oyente le re-pide al servidor, el
// servidor le re-pide al que hablaba (que conserva su frase en memoria).
func (s *segStore) pedirFaltantes(sg *segmento) {
	s.mu.Lock()
	if len(sg.faltan) == 0 || ahora()-sg.ultFalta < 700 {
		s.mu.Unlock()
		return
	}
	txs := make([]uint16, 0, len(sg.faltan))
	for t := range sg.faltan {
		txs = append(txs, t)
		if len(txs) >= 64 {
			break
		}
	}
	sg.ultFalta = ahora()
	s.mu.Unlock()
	c := s.mr.clienteDe(sg.De)
	if c == nil {
		return
	}
	msg, _ := json.Marshal(map[string]any{"t": "falta", "seq": sg.Seq, "txs": txs})
	c.enviarCtrl(append([]byte{1}, msg...))
}

// ackSegSiCompleto confirma al EMISOR que su audio llegó íntegro (su EOS fue
// visto y ya no falta ninguna trama): solo entonces puede soltar la "semilla"
// local de retransmisión de ese aid. Hasta ese ACK el cliente conserva todo.
func (s *segStore) ackSegSiCompleto(sg *segmento) {
	if sg == nil {
		return
	}
	s.mu.Lock()
	if sg.ackOk || !sg.eosVisto || len(sg.faltan) > 0 {
		s.mu.Unlock()
		return
	}
	sg.ackOk = true
	s.mu.Unlock()
	c := s.mr.clienteDe(sg.De)
	if c == nil {
		return
	}
	msg, _ := json.Marshal(map[string]any{"t": "seg_ack", "aid": sg.aid, "seq": sg.Seq})
	c.enviarCtrl(append([]byte{1}, msg...))
}

// abiertoDe devuelve el segmento actualmente abierto de un hablante.
func (s *segStore) abiertoDe(id string) *segmento {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.abiertos[id]
}

// notificarChunk avisa a los oyentes del grupo que el segmento tiene tramas
// nuevas disponibles para descarga. En el modelo pull el servidor NO empuja
// voz por el WebSocket: cada oyente baja las tramas por HTTP en orden
// estricto, así una conexión TCP atascada no frena a ninguna otra.
func (s *segStore) notificarChunk(sg *segmento) {
	if sg == nil {
		return
	}
	s.mu.Lock()
	if ahora()-sg.ultChunkNotif < 400 && sg.Abierto {
		s.mu.Unlock()
		return
	}
	sg.ultChunkNotif = ahora()
	seq, de, aid, g := sg.Seq, sg.De, int(sg.aid), sg.Grupo
	nombre := sg.Nombre
	ult := -1
	if sg.tieneTx {
		ult = int(idxDeTx(sg.ultTx))
	}
	cerr := !sg.Abierto
	s.mu.Unlock()
	msg, _ := json.Marshal(map[string]any{
		"t": "chunk", "seq": seq, "de": de, "aid": aid, "ult": ult, "cerr": cerr,
		"nombre": nombre,
	})
	s.mr.enviarCtrlGrupo(g, append([]byte{1}, msg...))
}

// contigHasta devuelve el aid del audio del segmento y el mayor idx tal que
// TODAS las tramas 0..idx ya están archivadas (-1 si aún falta la 0).
// Es el "ACK de recepción" que el emisor usa para soltar su semilla.
func (s *segStore) contigHasta(sg *segmento) (int, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if sg == nil || !sg.tieneTx || sg.aid == 0 {
		return 0, -1
	}
	idx := 0
	for idx < 4096 {
		tx := uint32(armarTx(sg.aid, uint16(idx)))
		_, a := sg.vistos[tx<<1|0]
		_, b := sg.vistos[tx<<1|1]
		if !a && !b {
			break
		}
		idx++
	}
	return int(sg.aid), idx - 1
}

// tramosDesde devuelve la racha CONTIGUA de tramas del segmento a partir del
// índice `desde` (las dos familias Opus/ADPCM comparten idx y viajan juntas)
// y una bandera que indica si el segmento está cerrado en el servidor. Si
// hay un hueco justo en `desde` o más adelante, se entrega solo hasta ahí:
// el cliente vuelve a pedir desde el mismo índice hasta que la pieza llegue.
func (s *segStore) tramosDesde(sg *segmento, desde uint16) ([][]byte, bool) {
	s.mu.Lock()
	frames := sg.frames
	if frames != nil {
		frames = append([][]byte(nil), frames...)
	}
	ruta := sg.ruta
	cerr := !sg.Abierto
	s.mu.Unlock()

	if frames == nil && ruta != "" {
		if b, err := os.ReadFile(ruta); err == nil {
			if _, fr, ok := parsearArchivoSeg(b); ok {
				frames = fr
			}
		}
	}
	if len(frames) == 0 {
		return nil, cerr
	}
	out := make([][]byte, 0, 128)
	esp := int(desde & 0x0fff)
	ultimo := -1
	for _, fr := range frames {
		if len(fr) < 3 {
			continue
		}
		idx := int(idxDeTx(txDeTrama(fr)))
		if ultimo >= 0 && idx == ultimo {
			out = append(out, fr) // variante hermana del mismo idx
			continue
		}
		diff := (idx - esp) & 0x0fff
		if diff >= 2048 {
			continue // trama anterior a 'desde'
		}
		if diff > 0 {
			break // hueco: solo se entrega la racha contigua
		}
		out = append(out, fr)
		ultimo = idx
		esp = (esp + 1) & 0x0fff
		if len(out) >= 200 {
			break // página de ~8 s de voz: el cliente pide lo que sigue
		}
	}
	return out, cerr
}

// enviarCtrlGrupo manda un mensaje de control a todos los clientes de un grupo.
func (r *mediaRoom) enviarCtrlGrupo(grupo int, raw []byte) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var dest []string
	for _, c := range r.clientes {
		if c.grupo == grupo {
			c.enviarCtrl(raw)
			dest = append(dest, c.identidad)
		}
	}
	// Diagnóstico de notas/historial: a qué grupo va cada evento de
	// segmento y qué clientes (con su grupo) lo reciben — si un oyente
	// falta aquí con otro grupo, el filtro lo está excluyendo del historial
	if len(raw) > 1 && raw[0] == 1 {
		var head struct {
			T   string `json:"t"`
			Seq uint32 `json:"seq"`
		}
		if json.Unmarshal(raw[1:], &head) == nil &&
			(head.T == "seg_ini" || head.T == "seg_fin") {
			todos := make([]string, 0, len(r.clientes))
			for _, c := range r.clientes {
				todos = append(todos, fmt.Sprintf("%s(g%d)", c.identidad, c.grupo))
			}
			log.Printf("[seg] %s seq=%d g=%d → %d/%d destino: %v | conectados: %v",
				head.T, head.Seq, grupo, len(dest), len(r.clientes), dest, todos)
		}
	}
}

// hAudioManifiesto atiende GET /api/salas/{sala}/audio?desde=N&g=G
// &ultimos=N recorta a los últimos N segmentos (siembra del chat al entrar).
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
	ultimos := 0
	if v := r.URL.Query().Get("ultimos"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			ultimos = n
		}
	}
	escribirJSON(w, 200, mr.seg.manifiesto(desde, grupo, ultimos))
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

// hAudioTramos atiende GET /api/salas/{sala}/audio/{seq}/tramos?desde=N
// Devuelve la racha contigua de tramas desde el índice N del audio (pull):
// formato binario [u8 ver=1][u8 flags][u32 seq][u16 n][u16 len][trama]*n
// flags bit0 = segmento cerrado en el servidor.
func hAudioTramos(w http.ResponseWriter, r *http.Request, cl *Claims) {
	sala := r.PathValue("sala")
	seq, err := strconv.ParseUint(r.PathValue("seq"), 10, 32)
	if err != nil {
		escribirJSON(w, 400, map[string]string{"error": "seq inválido"})
		return
	}
	mr := media.room(sala)
	sg := mr.seg.buscar(uint32(seq))
	if sg == nil {
		escribirJSON(w, 404, map[string]string{"error": "segmento no encontrado"})
		return
	}
	desde := uint16(0)
	if v := r.URL.Query().Get("desde"); v != "" {
		if n, err := strconv.ParseUint(v, 10, 16); err == nil {
			desde = uint16(n)
		}
	}
	frames, cerr := mr.seg.tramosDesde(sg, desde)
	flags := byte(0)
	if cerr {
		flags |= 1
	}
	out := make([]byte, 0, 8+len(frames)*96)
	out = append(out, 1, flags)
	var f4 [4]byte
	binary.BigEndian.PutUint32(f4[:], uint32(seq))
	out = append(out, f4[:]...)
	var f2 [2]byte
	binary.BigEndian.PutUint16(f2[:], uint16(len(frames)))
	out = append(out, f2[:]...)
	for _, fr := range frames {
		binary.BigEndian.PutUint16(f2[:], uint16(len(fr)))
		out = append(out, f2[:]...)
		out = append(out, fr...)
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(out)
}

// hAudioSubir atiende POST /api/salas/{sala}/audio/subir — cuerpo binario:
// [u8 ver=1][u16 n][u16 len][trama]*n donde cada trama es el mismo payload
// que antes viajaba dentro del mensaje binario del WS (rateCode + txLE +
// datos). Cada trozo viaja por su propia conexión HTTP: un trozo atascado
// se reintenta por otra conexión sin frenar a los demás, y el servidor
// archiva todo en su .seg y avisa a los oyentes con un control diminuto
// ('chunk'/'falta') para que descarguen la racha contigua por HTTP.
func hAudioSubir(w http.ResponseWriter, r *http.Request, cl *Claims) {
	sala := r.PathValue("sala")
	mr := media.room(sala)
	c := mr.clienteDe(cl.Identity)
	if c == nil {
		// Sin el socket de medios no hay grupo/piso que arbitrar: el cliente
		// reintenta el trozo tras reconectarse (la cola conserva la voz).
		escribirJSON(w, 409, map[string]string{"error": "socket de medios no conectado"})
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if r.Body != nil {
		r.Body.Close()
	}
	if err != nil || len(body) < 3 || body[0] != 1 {
		escribirJSON(w, 400, map[string]string{"error": "cuerpo de trozo inválido"})
		return
	}
	n := int(binary.BigEndian.Uint16(body[1:3]))
	i := 3
	var cerrados []*segmento
	for k := 0; k < n && i+2 <= len(body); k++ {
		l := int(binary.BigEndian.Uint16(body[i : i+2]))
		i += 2
		if l < 1 || i+l > len(body) {
			break
		}
		fr := body[i : i+l]
		i += l
		rc := fr[0]

		// Igual que en el WS: primero reparar (puede ser una pieza rezagada
		// de un audio ya cerrado con el mismo aid)
		if len(fr) >= 3 {
			if sgR, _ := mr.seg.reparar(c.identidad, fr); sgR != nil {
				mr.seg.pedirFaltantes(sgR)
				mr.seg.ackSegSiCompleto(sgR)
				if (rc == 0 || len(sgR.faltan) == 0) && sgR.DurMs >= 700 {
					mr.notificarSegFin(sgR)
				}
				mr.seg.notificarChunk(sgR)
				continue
			}
			aidTrama := aidDeTx(txDeTrama(fr))
			if (aidTrama != 0 && aidTrama == c.aidSuelto) ||
				(c.pisoSuelto && (aidTrama == 0 || aidTrama == c.pisoAid)) {
				continue
			}
			if aidTrama != 0 && aidTrama != c.pisoAid {
				c.pisoAid = aidTrama
				c.pisoSuelto = false
			}
		}
		// Piso exclusivo por trama, igual que en el WS
		if !mr.pisoCheck(c, rc) {
			continue
		}
		if !c.micOn {
			mr.mu.Lock()
			c.micOn = true
			mr.mu.Unlock()
			mr.difundirEstadoPeers(c.grupo)
		}
		nuevo, cerrado, faltan, _ := mr.seg.appendFrame(c.identidad, c.nombre, c.grupo, fr, false)
		if nuevo != nil {
			mr.seg.notificarSegIni(nuevo)
		}
		if cerrado != nil {
			mr.notificarSegFin(cerrado)
			mr.seg.ackSegSiCompleto(cerrado)
			cerrados = append(cerrados, cerrado)
		}
		if len(faltan) > 0 {
			msg, _ := json.Marshal(map[string]any{"t": "falta", "txs": faltan})
			c.enviarCtrl(append([]byte{1}, msg...))
		}
	}
	// Avisar a los oyentes que hay tramas nuevas para bajar por HTTP y
	// responder al emisor con su ACK: el seq abierto y hasta qué índice
	// contiguo tiene archivado el servidor (puede soltar su semilla hasta ahí)
	resp := map[string]any{"ok": true, "contig": -1}
	if sg := mr.seg.abiertoDe(c.identidad); sg != nil {
		mr.seg.notificarChunk(sg)
		aid, contig := mr.seg.contigHasta(sg)
		resp["seq"] = sg.Seq
		resp["aid"] = aid
		resp["contig"] = contig
	}
	for _, sg := range cerrados {
		mr.seg.notificarChunk(sg)
	}
	escribirJSON(w, 200, resp)
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

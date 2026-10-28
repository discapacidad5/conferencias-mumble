package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// ============================================================================
// 1. TOKENS DE PARTICIPANTE (HMAC-SHA256, sin depender de LiveKit)
// ============================================================================

type Claims struct {
	Identity  string `json:"sub"`
	Name      string `json:"name"`
	Sala      string `json:"sala"`
	Grupo     int    `json:"grupo"`
	RoomAdmin bool   `json:"admin"`
	CanMic    bool   `json:"mic"`
	CanCam    bool   `json:"cam"`
	CanPan    bool   `json:"pan"`
	Exp       int64  `json:"exp"`
}

func firmarToken(c Claims) (string, error) {
	if c.Exp == 0 {
		c.Exp = time.Now().Add(12 * time.Hour).Unix()
	}
	b, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	payload := base64.RawURLEncoding.EncodeToString(b)
	mac := hmac.New(sha256.New, []byte(appSecret))
	mac.Write([]byte(payload))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return payload + "." + sig, nil
}

func verificarToken(tok, salaEsperada string) (*Claims, error) {
	parts := strings.Split(tok, ".")
	if len(parts) != 2 {
		return nil, errors.New("token mal formado")
	}
	mac := hmac.New(sha256.New, []byte(appSecret))
	mac.Write([]byte(parts[0]))
	esperada := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(parts[1]), []byte(esperada)) {
		return nil, errors.New("firma inválida")
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, err
	}
	var c Claims
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, err
	}
	if time.Now().Unix() > c.Exp {
		return nil, errors.New("token expirado")
	}
	if salaEsperada != "" && baseSala(c.Sala) != salaEsperada {
		return nil, errors.New("token no válido para esta sala")
	}
	return &c, nil
}

// ============================================================================
// 2. PROTOCOLO PROPIO (WebSocket binario + segmentos de voz confiables)
// ============================================================================
//
// Encabezado de trama binaria WebSocket:
//   byte 0: tipo de trama
//     0x01 = Audio de micrófono (Opus/WebM o PCM µ-law 8/16kHz)
//     0x02 = Video ligero 240p (WebP/JPEG) — SOLO permitido a Asiento 1 y La Palabra
//     0x03 = Pantalla compartida ligera (WebP/JPEG) — SOLO permitido a Asiento 1 y La Palabra
//     0x04 = Audio compartido por moderador/anfitrión
//   byte 1: longitud de la identidad del emisor (N)
//   bytes 2..2+N: identidad del emisor (en paquetes salientes del servidor al cliente)
//   resto: payload binario del frame

const (
	frameTipoAudio    = 0x01
	frameTipoVideo    = 0x02
	frameTipoPantalla = 0x03
	frameTipoAudioSh  = 0x04
)

type clienteWS struct {
	identidad string
	nombre    string
	sala      string
	grupo     int
	esAdmin   bool
	connSid   string
	conn      *websocket.Conn
	ctrlCh    chan []byte // Señalización JSON (prioridad alta, nunca se descarta por audio)
	audioCh   chan []byte // Voz binaria en tiempo real (máx 10 tramas = 400ms, cero retraso acumulado)
	videoCh   chan []byte // Video y Pantalla (drop-oldest si la red celular es lenta)
	cerrado   chan struct{}
	once      sync.Once

	micOn      bool
	camOn      bool
	panOn      bool
	canMic     bool
	canCam     bool
	canPan     bool
	opusRx     bool
	pisoSuelto bool  // true tras piso_soltar: tramas rezagadas reparan la frase cerrada, no reabren el piso
	ultimoHabl int64 // unix ms de su última trama de voz aceptada (watchdog de piso)
	avisPiso   int64 // rate-limit del aviso piso_ocupado
}

func (c *clienteWS) cerrarConCodigo(code int, reason string) {
	c.once.Do(func() {
		close(c.cerrado)
		_ = c.conn.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(code, reason),
			time.Now().Add(2*time.Second),
		)
		_ = c.conn.Close()
	})
}

func (c *clienteWS) enviarCtrl(b []byte) {
	select {
	case <-c.cerrado:
		return
	default:
	}
	select {
	case c.ctrlCh <- b:
	default:
		// Si la cola de control/audio está llena, descartar el más viejo para mantener tiempo real
		select {
		case <-c.ctrlCh:
		default:
		}
		select {
		case c.ctrlCh <- b:
		default:
		}
	}
}

func (c *clienteWS) enviarBinarioAudio(b []byte) {
	select {
	case <-c.cerrado:
		return
	default:
	}
	select {
	case c.audioCh <- b:
	default:
		// Cola de 256 paquetes (~10 s) llena por corte severo: descartar el más antiguo
		select {
		case <-c.audioCh:
		default:
		}
		select {
		case c.audioCh <- b:
		default:
		}
	}
}

func (c *clienteWS) enviarVideoLigero(b []byte) {
	select {
	case <-c.cerrado:
		return
	default:
	}
	// Drop-oldest-frame: si el oyente tiene 3G/2G lento y aún no drenó el
	// frame anterior, lo reemplazamos por el más reciente. Así NUNCA se
	// acumula retraso ni interfiere con la voz.
	select {
	case c.videoCh <- b:
	default:
		select {
		case <-c.videoCh:
		default:
		}
		select {
		case c.videoCh <- b:
		default:
		}
	}
}

type mediaRoom struct {
	mu       sync.RWMutex
	sala     string
	clientes map[string]*clienteWS // identidad -> cliente activo
	seg      *segStore             // historial de notas de voz (segmentos recuperables)
}

type MediaHub struct {
	mu    sync.Mutex
	rooms map[string]*mediaRoom
}

func NewMediaHub() *MediaHub {
	return &MediaHub{rooms: map[string]*mediaRoom{}}
}

func (mh *MediaHub) room(sala string) *mediaRoom {
	mh.mu.Lock()
	defer mh.mu.Unlock()
	r, ok := mh.rooms[sala]
	if !ok {
		r = &mediaRoom{
			sala:     sala,
			clientes: map[string]*clienteWS{},
		}
		r.seg = nuevoSegStore(sala, r)
		mh.rooms[sala] = r
	}
	return r
}

func (mh *MediaHub) borrarRoom(sala string) {
	mh.mu.Lock()
	r, ok := mh.rooms[sala]
	if ok {
		delete(mh.rooms, sala)
	}
	mh.mu.Unlock()
	if ok && r != nil {
		r.mu.Lock()
		for _, c := range r.clientes {
			c.cerrarConCodigo(websocket.CloseGoingAway, "sala borrada")
		}
		r.clientes = map[string]*clienteWS{}
		r.mu.Unlock()
	}
}

// listarPorGrupo devuelve los participantes conectados a la sala en el grupo indicado.
func (mh *MediaHub) listarPorGrupo(sala string, grupo int) []*clienteWS {
	r := mh.room(sala)
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]*clienteWS, 0, len(r.clientes))
	for _, c := range r.clientes {
		if c.grupo == grupo {
			out = append(out, c)
		}
	}
	return out
}

func (mh *MediaHub) listarTodos(sala string) []*clienteWS {
	r := mh.room(sala)
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]*clienteWS, 0, len(r.clientes))
	for _, c := range r.clientes {
		out = append(out, c)
	}
	return out
}

// difundirEstadoPeers envía a todos los miembros del grupo la lista actualizada
// de participantes presentes y quién tiene micro/cámara/pantalla encendidos,
// además de indicar si hay algún oyente sin decodificador Opus nativo.
func (r *mediaRoom) difundirEstadoPeers(grupo int) {
	r.mu.RLock()
	peers := []map[string]any{}
	destinos := []*clienteWS{}
	haySinOpus := false
	for _, c := range r.clientes {
		if c.grupo == grupo {
			if !c.opusRx {
				haySinOpus = true
			}
			peers = append(peers, map[string]any{
				"identidad": c.identidad,
				"nombre":    c.nombre,
				"mic":       c.micOn && c.canMic,
				"cam":       c.camOn && c.canCam,
				"pan":       c.panOn && c.canPan,
				"canMic":    c.canMic,
				"canCam":    c.canCam,
				"canPan":    c.canPan,
			})
			destinos = append(destinos, c)
		}
	}
	r.mu.RUnlock()

	msg, _ := json.Marshal(map[string]any{
		"t":          "peers",
		"peers":      peers,
		"haySinOpus": haySinOpus,
	})
	raw := append([]byte{1}, msg...) // 1 = text JSON frame
	for _, d := range destinos {
		d.enviarCtrl(raw)
	}
}

// actualizarPermisoCliente sincroniza los permisos de micro/cámara/pantalla de
// un participante y apaga en el acto su cámara/micro si perdió el derecho
// (por ejemplo, al levantarse del Asiento 1 o al terminar su tiempo de Palabra).
func actualizarPermiso(sala, identidad string, mic, cam, pan bool) {
	r := media.room(sala)
	r.mu.Lock()
	c, ok := r.clientes[identidad]
	grupo := 0
	if ok {
		c.canMic = mic
		c.canCam = cam
		c.canPan = pan
		if !mic {
			c.micOn = false
		}
		if !cam {
			c.camOn = false
		}
		if !pan {
			c.panOn = false
		}
		grupo = c.grupo
	}
	r.mu.Unlock()
	if ok {
		msg, _ := json.Marshal(map[string]any{
			"t":      "permisos",
			"canMic": mic,
			"canCam": cam,
			"canPan": pan,
			"mic":    c.micOn,
			"cam":    c.camOn,
			"pan":    c.panOn,
		})
		c.enviarCtrl(append([]byte{1}, msg...))
		r.difundirEstadoPeers(grupo)
	}
	if !mic {
		liberarPisoDe(sala, identidad, false)
	}
}

func mutearPistas(sala string, _ int, identidad string, mic, cam bool) {
	r := media.room(sala)
	r.mu.Lock()
	c, ok := r.clientes[identidad]
	grupo := 0
	if ok {
		if mic {
			c.micOn = false
		}
		if cam {
			c.camOn = false
		}
		grupo = c.grupo
	}
	r.mu.Unlock()
	if ok {
		msg, _ := json.Marshal(map[string]any{
			"t":   "forzar_mute",
			"mic": mic,
			"cam": cam,
		})
		c.enviarCtrl(append([]byte{1}, msg...))
		r.difundirEstadoPeers(grupo)
	}
	if mic {
		liberarPisoDe(sala, identidad, false)
	}
}

func expulsarClienteWS(sala, identidad string) {
	r := media.room(sala)
	r.mu.Lock()
	c, ok := r.clientes[identidad]
	grupo := 0
	if ok {
		grupo = c.grupo
		delete(r.clientes, identidad)
	}
	r.mu.Unlock()
	if ok {
		c.cerrarConCodigo(4003, "expulsado de la sala")
		r.difundirEstadoPeers(grupo)
	}
}

func (r *mediaRoom) clienteDe(id string) *clienteWS {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.clientes[id]
}

// liberarPisoDe suelta el piso exclusivo de voz si id lo tiene y cierra la
// frase (segmento) que tuviera abierta. Interrumpida marca la nota de voz
// como cortada por otro hablante.
func liberarPisoDe(sala, id string, interrumpida bool) {
	mr := media.room(sala)
	if sg := mr.seg.cerrarHablante(id, interrumpida); sg != nil {
		mr.notificarSegFin(sg)
		mr.seg.pedirFaltantes(sg)
	}
	sv := hub.sala(sala)
	sv.mu.Lock()
	solto, reasignado := sv.soltarPisoEn(sv.estadoDe(id), id)
	if solto {
		sv.broadcast(&Evento{Tipo: "piso"})
	}
	sv.mu.Unlock()
	if reasignado != "" {
		// el piso volvió solo a quien tiene La Palabra: su cliente lo toma
		// como concedido y su micro sigue activo sin tocar nada
		if pc := mr.clienteDe(reasignado); pc != nil {
			pc.ultimoHabl = ahora() // margen: su cliente reanuda el envío
			msg, _ := json.Marshal(map[string]any{"t": "piso_ok"})
			pc.enviarCtrl(append([]byte{1}, msg...))
		}
	}
}

// tomarPisoWS responde al mensaje WS {t:"piso_tomar"}: aplica la regla del
// mínimo de tiempos entre los roles del solicitante. Si el piso está ocupado
// responde piso_ocupado con los segundos restantes; si lo roba, cierra la
// frase del anterior como interrumpida y le avisa con piso_perdido.
func (r *mediaRoom) tomarPisoWS(c *clienteWS) {
	sv := hub.sala(r.sala)
	sv.mu.Lock()
	e := sv.estadoDe(c.identidad)
	soyMod := c.esAdmin || sv.esModerador(c.identidad)
	if !sv.puedeMic(c.identidad, soyMod) {
		sv.mu.Unlock()
		msg, _ := json.Marshal(map[string]any{"t": "piso_ocupado", "error": "sin permiso de micrófono"})
		c.enviarCtrl(append([]byte{1}, msg...))
		return
	}
	res, faltan, anterior := sv.tomarPisoEn(e, c.identidad, c.nombre, soyMod)
	holderNombre := e.PisoNombre
	if res == pisoTomado || res == pisoRobado {
		sv.broadcast(&Evento{Tipo: "piso"})
	}
	sv.mu.Unlock()

	switch res {
	case pisoYaMio, pisoTomado:
		c.ultimoHabl = ahora()
		msg, _ := json.Marshal(map[string]any{"t": "piso_ok"})
		c.enviarCtrl(append([]byte{1}, msg...))
	case pisoRobado:
		c.ultimoHabl = ahora()
		if sg := r.seg.cerrarHablante(anterior, true); sg != nil {
			r.notificarSegFin(sg)
			r.seg.pedirFaltantes(sg)
		}
		if oc := r.clienteDe(anterior); oc != nil {
			msg, _ := json.Marshal(map[string]any{"t": "piso_perdido", "por": c.nombre})
			oc.enviarCtrl(append([]byte{1}, msg...))
		}
		msg, _ := json.Marshal(map[string]any{"t": "piso_ok"})
		c.enviarCtrl(append([]byte{1}, msg...))
	case pisoOcupadoR:
		msg, _ := json.Marshal(map[string]any{"t": "piso_ocupado", "nombre": holderNombre, "faltan": faltan})
		c.enviarCtrl(append([]byte{1}, msg...))
	}
}

// pisoCheck arbitra el piso por cada trama de voz entrante: solo pasa audio
// del dueño del piso. El primer hablante lo toma automáticamente; si otro
// transmite mientras tanto y su tiempo mínimo ya pasó, se lo arrebata (robo
// implícito por hablar). Las tramas rechazadas reciben piso_ocupado (máx.
// 1 aviso cada 4 s por cliente para no saturar).
// Devuelve true si la trama puede pasar a fanout/segmento.
func (r *mediaRoom) pisoCheck(c *clienteWS, rc byte) bool {
	sv := hub.sala(r.sala)
	sv.mu.Lock()
	e := sv.estadoDe(c.identidad)
	soyMod := c.esAdmin || sv.esModerador(c.identidad)
	if rc == 0 {
		// EOS siempre pasa: solo cierra la frase abierta del propio emisor
		sv.mu.Unlock()
		return true
	}
	if !sv.puedeMic(c.identidad, soyMod) {
		sv.mu.Unlock()
		return false
	}
	res, faltan, anterior := sv.tomarPisoEn(e, c.identidad, c.nombre, soyMod)
	holderNombre := e.PisoNombre
	if res == pisoTomado || res == pisoRobado {
		sv.broadcast(&Evento{Tipo: "piso"})
	}
	sv.mu.Unlock()

	switch res {
	case pisoYaMio, pisoTomado:
		c.ultimoHabl = ahora()
		return true
	case pisoRobado:
		c.ultimoHabl = ahora()
		if sg := r.seg.cerrarHablante(anterior, true); sg != nil {
			r.notificarSegFin(sg)
			r.seg.pedirFaltantes(sg)
		}
		if oc := r.clienteDe(anterior); oc != nil {
			msg, _ := json.Marshal(map[string]any{"t": "piso_perdido", "por": c.nombre})
			oc.enviarCtrl(append([]byte{1}, msg...))
		}
		return true
	}
	if ahora()-c.avisPiso >= 4000 {
		c.avisPiso = ahora()
		msg, _ := json.Marshal(map[string]any{"t": "piso_ocupado", "nombre": holderNombre, "faltan": faltan})
		c.enviarCtrl(append([]byte{1}, msg...))
	}
	return false
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  32 * 1024,
	WriteBufferSize: 32 * 1024,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

// hMediaWS atiende GET /api/salas/{sala}/media?token=...
func hMediaWS(w http.ResponseWriter, r *http.Request, cl *Claims) {
	sala := r.PathValue("sala")
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	sv := hub.sala(sala)
	sv.mu.Lock()
	grupo := sv.grupoDe[cl.Identity]
	soyMod := cl.RoomAdmin || sv.esModerador(cl.Identity)
	canMic := sv.puedeMic(cl.Identity, soyMod)
	canCam := sv.puedeCam(cl.Identity)
	canPan := sv.puedePantalla(cl.Identity)
	nombre := sv.nombres[cl.Identity]
	if nombre == "" {
		nombre = cl.Name
	}
	sv.presentes[cl.Identity] = grupo
	if cl.RoomAdmin {
		sv.admins[cl.Identity] = true
	} else {
		delete(sv.admins, cl.Identity)
	}
	delete(sv.ausente, cl.Identity)
	estadoInicial, _ := marshalEstadoPara(sv, nil, cl.Identity)
	sv.mu.Unlock()

	if tcpConn, ok := conn.UnderlyingConn().(*net.TCPConn); ok {
		_ = tcpConn.SetNoDelay(true)
	}

	c := &clienteWS{
		identidad: cl.Identity,
		nombre:    nombre,
		sala:      sala,
		grupo:     grupo,
		esAdmin:   cl.RoomAdmin,
		connSid:   r.URL.Query().Get("sid"),
		conn:      conn,
		ctrlCh:    make(chan []byte, 128),
		audioCh:   make(chan []byte, 512), // ~20 s de ráfaga celular: jamás descartar tramas cuando llegan juntas tras un bache
		videoCh:   make(chan []byte, 2),   // máximo 2 frames en cola: cero latencia acumulada
		cerrado:   make(chan struct{}),
		canMic:    canMic,
		canCam:    canCam,
		canPan:    canPan,
		opusRx:    r.URL.Query().Get("opus") == "1",
	}

	mr := media.room(sala)
	mr.mu.Lock()
	prev := mr.clientes[c.identidad]
	mr.clientes[c.identidad] = c
	mr.mu.Unlock()

	// Si es la misma pestaña reconectándose tras un micro-corte WiFi (mismo sid),
	// cerrar el socket viejo en silencio (1000). Solo usar 4002 si es otro dispositivo/pestaña.
	if prev != nil && prev != c {
		if prev.connSid != "" && prev.connSid == c.connSid {
			prev.cerrarConCodigo(websocket.CloseNormalClosure, "reconnected")
		} else {
			prev.cerrarConCodigo(4002, "DUPLICATE_IDENTITY")
		}
	}

	mr.difundirEstadoPeers(grupo)

	// Enviar bienvenida con permisos iniciales y el último segmento de voz
	// cerrado (para que el cliente re-pida lo que se perdió tras un corte)
	initMsg, _ := json.Marshal(map[string]any{
		"t":         "bienvenida",
		"identidad": c.identidad,
		"grupo":     c.grupo,
		"canMic":    c.canMic,
		"canCam":    c.canCam,
		"canPan":    c.canPan,
		"ultimoSeg": mr.seg.ultimoCerrado(),
	})
	c.enviarCtrl(append([]byte{1}, initMsg...))
	if len(estadoInicial) > 0 {
		pushMsg := append([]byte(`{"t":"estado_push","d":`), estadoInicial...)
		pushMsg = append(pushMsg, '}')
		c.enviarCtrl(append([]byte{1}, pushMsg...))
	}

	// Goroutine escritora: prioriza siempre audioCh (voz) y ctrlCh (señalización)
	// sobre videoCh (fotogramas 240p) para que la voz jamás se entrecorte.
	escribirCtrl := func(msg []byte) bool {
		_ = conn.SetWriteDeadline(time.Now().Add(8 * time.Second))
		if len(msg) > 0 && msg[0] == 1 {
			if err := conn.WriteMessage(websocket.TextMessage, msg[1:]); err != nil {
				c.cerrarConCodigo(websocket.CloseGoingAway, "")
				return false
			}
		} else if len(msg) > 0 {
			if err := conn.WriteMessage(websocket.BinaryMessage, msg[1:]); err != nil {
				c.cerrarConCodigo(websocket.CloseGoingAway, "")
				return false
			}
		}
		return true
	}
	escribirAudio := func(amsg []byte) bool {
		_ = conn.SetWriteDeadline(time.Now().Add(8 * time.Second))
		if err := conn.WriteMessage(websocket.BinaryMessage, amsg); err != nil {
			c.cerrarConCodigo(websocket.CloseGoingAway, "")
			return false
		}
		return true
	}

	go func() {
		// Ping cada 5s mantiene despierta la radio WiFi del móvil (evita que entre
		// en Power Save Mode cada 2-3 min) y acelera la detección de pérdida TCP.
		pingTk := time.NewTicker(5 * time.Second)
		defer pingTk.Stop()
		for {
			// 1. Drenar primero cualquier paquete de voz o control pendiente
			select {
			case <-c.cerrado:
				return
			case amsg := <-c.audioCh:
				if !escribirAudio(amsg) {
					return
				}
				continue
			case msg := <-c.ctrlCh:
				if !escribirCtrl(msg) {
					return
				}
				continue
			default:
			}

			// 2. Si no hay voz ni control esperando, atender cualquier canal
			select {
			case <-c.cerrado:
				return
			case amsg := <-c.audioCh:
				if !escribirAudio(amsg) {
					return
				}
			case msg := <-c.ctrlCh:
				if !escribirCtrl(msg) {
					return
				}
			case vmsg := <-c.videoCh:
				_ = conn.SetWriteDeadline(time.Now().Add(8 * time.Second))
				if err := conn.WriteMessage(websocket.BinaryMessage, vmsg); err != nil {
					c.cerrarConCodigo(websocket.CloseGoingAway, "")
					return
				}
			case <-pingTk.C:
				_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
				if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
					c.cerrarConCodigo(websocket.CloseGoingAway, "")
					return
				}
			}
		}
	}()

	// Bucle lector
	conn.SetReadLimit(512 * 1024)
	_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	conn.SetPongHandler(func(string) error {
		_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	for {
		mtype, data, err := conn.ReadMessage()
		if err != nil {
			break
		}
		_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))

		if mtype == websocket.TextMessage {
			var m map[string]any
			if json.Unmarshal(data, &m) != nil {
				continue
			}
			tipo, _ := m["t"].(string)
			switch tipo {
			case "piso_tomar":
				mr.tomarPisoWS(c)

			case "piso_soltar":
				liberarPisoDe(sala, c.identidad, false)

			case "piso_hold":
				// Latido del PTT sostenido: mantiene vivo el piso aunque el
				// hablante haga pausas (VAD deja de emitir tramas en silencio)
				c.ultimoHabl = ahora()

			case "ping_net":
				// Medición de RTT y jitter del cliente para ajuste automático de bitrate (8–28 kbps)
				pong, _ := json.Marshal(map[string]any{
					"t":  "pong_net",
					"ts": m["ts"],
				})
				c.enviarCtrl(append([]byte{1}, pong...))

			case "estado_media":
				// El cliente informa si encendió/apagó su micro, cámara o pantalla y su soporte Opus
				mr.mu.Lock()
				if v, ok := m["mic"].(bool); ok {
					c.micOn = v && c.canMic
				}
				if v, ok := m["cam"].(bool); ok {
					c.camOn = v && c.canCam
				}
				if v, ok := m["pan"].(bool); ok {
					c.panOn = v && c.canPan
				}
				if v, ok := m["opusRx"].(bool); ok {
					c.opusRx = v
				}
				gActual := c.grupo
				micApagado := !c.micOn
				mr.mu.Unlock()
				if micApagado {
					liberarPisoDe(sala, c.identidad, false)
				}
				mr.difundirEstadoPeers(gActual)

			case "cambiar_grupo":
				sv.mu.Lock()
				soyModNow := c.esAdmin || sv.esModerador(c.identidad)
				nuevoG := sv.grupoDe[c.identidad]
				if gf, ok := m["grupo"].(float64); ok && soyModNow {
					nuevoG = int(gf)
					sv.moverAGrupo(c.identidad, nuevoG)
				}
				c.canMic = sv.puedeMic(c.identidad, soyModNow)
				c.canCam = sv.puedeCam(c.identidad)
				c.canPan = sv.puedePantalla(c.identidad)
				sv.presentes[c.identidad] = nuevoG
				sv.mu.Unlock()

				mr.mu.Lock()
				viejoG := c.grupo
				c.grupo = nuevoG
				if !c.canCam {
					c.camOn = false
				}
				if !c.canMic {
					c.micOn = false
				}
				mr.mu.Unlock()
				if viejoG != nuevoG {
					mr.difundirEstadoPeers(viejoG)
				}
				mr.difundirEstadoPeers(nuevoG)

			default:
				// Mensajes de datos de la sala (chat, pizarra wb, reacciones, audio compartido)
				m["from"] = c.identidad
				m["fromName"] = c.nombre
				reenvio, _ := json.Marshal(m)
				raw := append([]byte{1}, reenvio...)
				mr.mu.RLock()
				for _, otro := range mr.clientes {
					if otro != c && otro.grupo == c.grupo {
						otro.enviarCtrl(raw)
					}
				}
				mr.mu.RUnlock()
			}
			continue
		}

		if mtype == websocket.BinaryMessage && len(data) > 1 {
			ftipo := data[0]
			payload := data[1:]

			// Empaquetar con la identidad del emisor: [ftipo][len(id)][id][payload]
			idBytes := []byte(c.identidad)
			if len(idBytes) > 250 {
				idBytes = idBytes[:250]
			}
			out := make([]byte, 2+len(idBytes)+len(payload))
			out[0] = ftipo
			out[1] = byte(len(idBytes))
			copy(out[2:], idBytes)
			copy(out[2+len(idBytes):], payload)

			switch ftipo {
			case frameTipoAudio:
				if !c.canMic || len(payload) < 1 {
					continue
				}
				rc := payload[0]
				// Reparación anti-pérdida: si esta tx rellena un hueco explícito
				// de un segmento ya cerrado, se archiva en ese archivo
				if len(payload) >= 3 && rc != 0 {
					if sgR := mr.seg.reparar(c.identidad, payload); sgR != nil {
						mr.seg.pedirFaltantes(sgR)
						continue
					}
				}
				// Piso exclusivo: solo pasa la voz del dueño del piso; hablar
				// lo toma en automático y un tercero puede tumbártelo según los
				// tiempos de interrupción configurados por rol.
				if !mr.pisoCheck(c, rc) {
					continue
				}
				if !c.micOn {
					mr.mu.Lock()
					c.micOn = true
					mr.mu.Unlock()
					mr.difundirEstadoPeers(c.grupo)
				}
				// rc == 0: marcador explícito de fin de frase (EOS), llega a todos los oyentes
				// rc 10..19 = Opus (solo para clientes con opusRx=true)
				// rc 30..39 = ADPCM respaldo simultáneo (solo para clientes con opusRx=false)
				// rc 20..29 o 1..2 = ADPCM/u-law primario (para todos cuando el emisor no tiene Opus)
				mr.mu.RLock()
				for _, otro := range mr.clientes {
					if otro == c || otro.grupo != c.grupo {
						continue
					}
					if rc >= 10 && rc <= 19 && !otro.opusRx {
						continue
					}
					if rc >= 30 && rc <= 39 && otro.opusRx {
						continue
					}
					otro.enviarBinarioAudio(out)
				}
				mr.mu.RUnlock()

				// Historial confiable: la frase se archiva como segmento
				// descargable para reparar micro-cortes y notas de voz. El
				// servidor deduplica por tx, las inserta en orden y le pide
				// al emisor ({t:'falta'}) las tramas que detecta perdidas.
				nuevo, cerrado, faltan := mr.seg.appendFrame(c.identidad, c.nombre, c.grupo, payload, false)
				if nuevo != nil {
					mr.seg.notificarSegIni(nuevo)
				}
				if cerrado != nil {
					mr.notificarSegFin(cerrado)
				}
				if len(faltan) > 0 {
					msg, _ := json.Marshal(map[string]any{"t": "falta", "txs": faltan})
					c.enviarCtrl(append([]byte{1}, msg...))
				}

			case frameTipoVideo:
				// Regla estricta: SOLO Asiento 1 y La Palabra tienen canCam = true
				if !c.canCam {
					continue
				}
				if !c.camOn {
					mr.mu.Lock()
					c.camOn = true
					mr.mu.Unlock()
					mr.difundirEstadoPeers(c.grupo)
				}
				mr.mu.RLock()
				for _, otro := range mr.clientes {
					if otro != c && otro.grupo == c.grupo {
						otro.enviarVideoLigero(out)
					}
				}
				mr.mu.RUnlock()

			case frameTipoPantalla:
				if !c.canPan {
					continue
				}
				if !c.panOn {
					mr.mu.Lock()
					c.panOn = true
					mr.mu.Unlock()
					mr.difundirEstadoPeers(c.grupo)
				}
				mr.mu.RLock()
				for _, otro := range mr.clientes {
					if otro != c && otro.grupo == c.grupo {
						otro.enviarVideoLigero(out)
					}
				}
				mr.mu.RUnlock()

			case frameTipoAudioSh:
				if len(payload) < 2 {
					continue
				}
				rc := payload[0]
				mr.mu.RLock()
				for _, otro := range mr.clientes {
					if otro == c || otro.grupo != c.grupo {
						continue
					}
					if rc >= 10 && rc <= 19 && !otro.opusRx {
						continue
					}
					if rc >= 30 && rc <= 39 && otro.opusRx {
						continue
					}
					otro.enviarBinarioAudio(out)
				}
				mr.mu.RUnlock()
			}
		}
	}

	// Limpieza al desconectarse (solo si sigue siendo la instancia activa)
	mr.mu.Lock()
	sigueActivo := mr.clientes[c.identidad] == c
	if sigueActivo {
		delete(mr.clientes, c.identidad)
	}
	mr.mu.Unlock()
	c.cerrarConCodigo(websocket.CloseNormalClosure, "")
	if sigueActivo {
		liberarPisoDe(sala, c.identidad, false)
		mr.difundirEstadoPeers(c.grupo)
	}
}

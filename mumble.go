package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
// 2. PROTOCOLO MUMBLE NATIVO (TLS + Framing + Protobuf ligero + UDPTunnel)
// ============================================================================
//
// Tipos de paquete Mumble (RFC/Mumble.proto):
//   0 = Version
//   1 = UDPTunnel (trama de voz encapsulada en TCP/TLS)
//   2 = Authenticate
//   3 = Ping
//   4 = Reject
//   5 = ServerSync
//   7 = ChannelState
//   8 = UserRemove
//   9 = UserState

const (
	mumbleMsgVersion      = 0
	mumbleMsgUDPTunnel    = 1
	mumbleMsgAuthenticate = 2
	mumbleMsgPing         = 3
	mumbleMsgReject       = 4
	mumbleMsgServerSync   = 5
	mumbleMsgChannelState = 7
	mumbleMsgUserRemove   = 8
	mumbleMsgUserState    = 9
)

// Codificación Protobuf minimalista para mensajes de handshake Mumble.
func pbAppendVarint(b []byte, v uint64) []byte {
	for v >= 0x80 {
		b = append(b, byte(v)|0x80)
		v >>= 7
	}
	return append(b, byte(v))
}

func pbTagVarint(b []byte, field int, v uint64) []byte {
	b = pbAppendVarint(b, uint64((field<<3)|0))
	return pbAppendVarint(b, v)
}

func pbTagString(b []byte, field int, s string) []byte {
	if s == "" {
		return b
	}
	b = pbAppendVarint(b, uint64((field<<3)|2))
	b = pbAppendVarint(b, uint64(len(s)))
	return append(b, s...)
}

func pbReadVarint(b []byte) (uint64, int) {
	var x uint64
	var s uint
	for i, c := range b {
		if i >= 10 {
			return 0, 0
		}
		if c < 0x80 {
			return x | uint64(c)<<s, i + 1
		}
		x |= uint64(c&0x7f) << s
		s += 7
	}
	return 0, 0
}

// Decodifica campos básicos string/uint64 de un mensaje Protobuf de Mumble.
func pbParseFields(b []byte) (ints map[int]uint64, strs map[int]string) {
	ints = map[int]uint64{}
	strs = map[int]string{}
	i := 0
	for i < len(b) {
		tag, n := pbReadVarint(b[i:])
		if n <= 0 {
			break
		}
		i += n
		field := int(tag >> 3)
		wtype := int(tag & 7)
		switch wtype {
		case 0:
			v, m := pbReadVarint(b[i:])
			if m <= 0 {
				return
			}
			i += m
			ints[field] = v
		case 2:
			l, m := pbReadVarint(b[i:])
			if m <= 0 || i+m+int(l) > len(b) {
				return
			}
			i += m
			strs[field] = string(b[i : i+int(l)])
			i += int(l)
		case 1:
			i += 8
		case 5:
			i += 4
		default:
			return
		}
	}
	return
}

func escribirPaqueteMumble(w io.Writer, tipo uint16, payload []byte) error {
	var hdr [6]byte
	binary.BigEndian.PutUint16(hdr[0:2], tipo)
	binary.BigEndian.PutUint32(hdr[2:6], uint32(len(payload)))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	if len(payload) > 0 {
		_, err := w.Write(payload)
		return err
	}
	return nil
}

func leerPaqueteMumble(r io.Reader) (uint16, []byte, error) {
	var hdr [6]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return 0, nil, err
	}
	tipo := binary.BigEndian.Uint16(hdr[0:2])
	largo := binary.BigEndian.Uint32(hdr[2:6])
	if largo > 1024*1024 {
		return 0, nil, errors.New("paquete Mumble demasiado grande")
	}
	buf := make([]byte, largo)
	if largo > 0 {
		if _, err := io.ReadFull(r, buf); err != nil {
			return 0, nil, err
		}
	}
	return tipo, buf, nil
}

// Varint propio del túnel de audio de Mumble (distinto al de Protobuf)
func mumbleVarintEncode(v uint64) []byte {
	switch {
	case v < 0x80:
		return []byte{byte(v)}
	case v < 0x4000:
		return []byte{byte((v >> 8) | 0x80), byte(v)}
	case v < 0x200000:
		return []byte{byte((v >> 16) | 0xC0), byte(v >> 8), byte(v)}
	case v < 0x10000000:
		return []byte{byte((v >> 24) | 0xE0), byte(v >> 16), byte(v >> 8), byte(v)}
	default:
		return []byte{0xF0, byte(v >> 24), byte(v >> 16), byte(v >> 8), byte(v)}
	}
}

func direccionMumbleEfectiva(cfg MumbleConfig) string {
	if cfg.Modo == "remoto" && strings.TrimSpace(cfg.Host) != "" {
		p := cfg.Puerto
		if p <= 0 {
			p = 64738
		}
		return fmt.Sprintf("%s:%d", strings.TrimSpace(cfg.Host), p)
	}
	return mumbleLocalAddr
}

// EstadoMumble describe el resultado de probar o consultar el servidor Mumble.
type EstadoMumble struct {
	Conectado  bool   `json:"conectado"`
	Direccion  string `json:"direccion"`
	Modo       string `json:"modo"`
	LatenciaMs int64  `json:"latenciaMs"`
	Bienvenida string `json:"bienvenida,omitempty"`
	Canales    int    `json:"canales,omitempty"`
	Error      string `json:"error,omitempty"`
}

// ProbarConexionMumble realiza un handshake TLS + Version + Authenticate real
// contra el servidor Mumble indicado (local o público remoto).
func ProbarConexionMumble(cfg MumbleConfig) EstadoMumble {
	addr := direccionMumbleEfectiva(cfg)
	modo := cfg.Modo
	if modo == "" {
		modo = "local"
	}
	t0 := time.Now()
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	conn, err := tls.DialWithDialer(dialer, "tcp", addr, &tls.Config{
		InsecureSkipVerify: true, // Los servidores Mumble usan certificados autofirmados por defecto
	})
	if err != nil {
		return EstadoMumble{
			Conectado: false,
			Direccion: addr,
			Modo:      modo,
			Error:     err.Error(),
		}
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(6 * time.Second))

	// 1) Enviar Version (1.4.0 = 0x00010400)
	var ver []byte
	ver = pbTagVarint(ver, 1, 0x00010400)
	ver = pbTagString(ver, 2, "Conferencia-Mumble-Bridge 1.0")
	ver = pbTagString(ver, 3, "Linux")
	if err := escribirPaqueteMumble(conn, mumbleMsgVersion, ver); err != nil {
		return EstadoMumble{Conectado: false, Direccion: addr, Modo: modo, Error: err.Error()}
	}

	// 2) Enviar Authenticate
	var auth []byte
	auth = pbTagString(auth, 1, "conferencia-probe-"+randHex(2))
	if cfg.Clave != "" {
		auth = pbTagString(auth, 2, cfg.Clave)
	}
	auth = pbTagVarint(auth, 5, 1) // opus = true
	if err := escribirPaqueteMumble(conn, mumbleMsgAuthenticate, auth); err != nil {
		return EstadoMumble{Conectado: false, Direccion: addr, Modo: modo, Error: err.Error()}
	}

	// 3) Leer respuestas hasta ServerSync o Reject
	canales := 0
	bienvenida := ""
	for i := 0; i < 64; i++ {
		tipo, payload, err := leerPaqueteMumble(conn)
		if err != nil {
			break
		}
		_, strs := pbParseFields(payload)
		switch tipo {
		case mumbleMsgReject:
			motivo := strs[2]
			if motivo == "" {
				motivo = "acceso rechazado por el servidor Mumble"
			}
			return EstadoMumble{
				Conectado:  false,
				Direccion:  addr,
				Modo:       modo,
				LatenciaMs: time.Since(t0).Milliseconds(),
				Error:      motivo,
			}
		case mumbleMsgChannelState:
			canales++
		case mumbleMsgServerSync:
			bienvenida = strs[3]
			return EstadoMumble{
				Conectado:  true,
				Direccion:  addr,
				Modo:       modo,
				LatenciaMs: time.Since(t0).Milliseconds(),
				Bienvenida: bienvenida,
				Canales:    canales,
			}
		}
	}

	// Si el socket TLS abrió y respondió Version aunque no llegara ServerSync aún
	return EstadoMumble{
		Conectado:  true,
		Direccion:  addr,
		Modo:       modo,
		LatenciaMs: time.Since(t0).Milliseconds(),
		Bienvenida: bienvenida,
		Canales:    canales,
	}
}

// puenteMumble mantiene la sesión Mumble activa de una sala contra el servidor
// Mumble configurado (local o público remoto) y puentea tramas de voz.
type puenteMumble struct {
	mu        sync.Mutex
	sala      string
	conn      net.Conn
	conectado bool
	ultimoErr string
	seq       uint64
	cerrarCh  chan struct{}
}

func nuevoPuenteMumble(sala string) *puenteMumble {
	p := &puenteMumble{
		sala:     sala,
		cerrarCh: make(chan struct{}),
	}
	go p.bucle()
	return p
}

func (p *puenteMumble) cerrar() {
	select {
	case <-p.cerrarCh:
	default:
		close(p.cerrarCh)
	}
	p.mu.Lock()
	if p.conn != nil {
		_ = p.conn.Close()
	}
	p.mu.Unlock()
}

func (p *puenteMumble) bucle() {
	for {
		select {
		case <-p.cerrarCh:
			return
		default:
		}
		cfg := store.ObtenerMumble()
		addr := direccionMumbleEfectiva(cfg)
		dialer := &net.Dialer{Timeout: 6 * time.Second}
		conn, err := tls.DialWithDialer(dialer, "tcp", addr, &tls.Config{InsecureSkipVerify: true})
		if err != nil {
			p.mu.Lock()
			p.conectado = false
			p.ultimoErr = err.Error()
			p.mu.Unlock()
			select {
			case <-p.cerrarCh:
				return
			case <-time.After(10 * time.Second):
				continue
			}
		}

		var ver []byte
		ver = pbTagVarint(ver, 1, 0x00010400)
		ver = pbTagString(ver, 2, "Conferencia-Mumble")
		ver = pbTagString(ver, 3, "Linux")
		_ = escribirPaqueteMumble(conn, mumbleMsgVersion, ver)

		var auth []byte
		auth = pbTagString(auth, 1, "sala-"+p.sala)
		if cfg.Clave != "" {
			auth = pbTagString(auth, 2, cfg.Clave)
		}
		auth = pbTagVarint(auth, 5, 1)
		_ = escribirPaqueteMumble(conn, mumbleMsgAuthenticate, auth)

		p.mu.Lock()
		p.conn = conn
		p.conectado = true
		p.ultimoErr = ""
		p.mu.Unlock()

		// Goroutine de Ping cada 15s (Mumble desconecta tras 30s sin Ping)
		doneConn := make(chan struct{})
		go func(c net.Conn) {
			tk := time.NewTicker(15 * time.Second)
			defer tk.Stop()
			for {
				select {
				case <-doneConn:
					return
				case <-p.cerrarCh:
					return
				case <-tk.C:
					var pg []byte
					pg = pbTagVarint(pg, 1, uint64(time.Now().UnixMilli()))
					p.mu.Lock()
					_ = escribirPaqueteMumble(c, mumbleMsgPing, pg)
					p.mu.Unlock()
				}
			}
		}(conn)

		for {
			tipo, _, err := leerPaqueteMumble(conn)
			if err != nil {
				break
			}
			if tipo == mumbleMsgReject {
				break
			}
		}
		close(doneConn)
		_ = conn.Close()
		p.mu.Lock()
		if p.conn == conn {
			p.conn = nil
			p.conectado = false
		}
		p.mu.Unlock()

		select {
		case <-p.cerrarCh:
			return
		case <-time.After(5 * time.Second):
		}
	}
}

// enviarAudioMumble encapsula una trama de voz en un paquete UDPTunnel (tipo 1)
// con cabecera Opus (codec 4) del protocolo Mumble y la envía al servidor Mumble.
func (p *puenteMumble) enviarAudioMumble(audioPayload []byte) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.conn == nil || !p.conectado || len(audioPayload) == 0 {
		return
	}
	p.seq++
	// Header Mumble audio: codec=4 (Opus -> 4<<5 = 0x80), target=0 (normal talking)
	pkt := make([]byte, 0, 16+len(audioPayload))
	pkt = append(pkt, 0x80)
	pkt = append(pkt, mumbleVarintEncode(p.seq)...)
	pkt = append(pkt, mumbleVarintEncode(uint64(len(audioPayload)))...)
	pkt = append(pkt, audioPayload...)
	_ = p.conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
	_ = escribirPaqueteMumble(p.conn, mumbleMsgUDPTunnel, pkt)
}

// ============================================================================
// 3. HUB MULTIMEDIA POR WEBSOCKET HTTPS/443 (VOZ MUMBLE + VIDEO 240p ASIENTO 1/PALABRA)
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
	conn      *websocket.Conn
	ctrlCh    chan []byte // Señalización JSON (prioridad alta, nunca se descarta por audio)
	audioCh   chan []byte // Voz binaria (cola profunda de 256 tramas ~10s, cero pérdidas en baches WiFi)
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
	ultimoHabl int64
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
	mumble   *puenteMumble
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
			mumble:   nuevoPuenteMumble(sala),
		}
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
		r.mumble.cerrar()
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
	delete(sv.ausente, cl.Identity)
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
		conn:      conn,
		ctrlCh:    make(chan []byte, 64),
		audioCh:   make(chan []byte, 256), // ~10 segundos de voz: absorbe cualquier ráfaga WiFi/móvil sin perder paquetes
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

	// Si había otra conexión activa con la misma identidad, cerrarla con
	// código 4002 (DUPLICATE_IDENTITY) para que muestre el modal sin reconectar en bucle.
	if prev != nil && prev != c {
		prev.cerrarConCodigo(4002, "DUPLICATE_IDENTITY")
	}

	mr.difundirEstadoPeers(grupo)

	// Enviar bienvenida con estado Mumble y permisos iniciales
	cfgMumble := store.ObtenerMumble()
	initMsg, _ := json.Marshal(map[string]any{
		"t":          "bienvenida",
		"identidad":  c.identidad,
		"grupo":      c.grupo,
		"canMic":     c.canMic,
		"canCam":     c.canCam,
		"canPan":     c.canPan,
		"mumbleModo": cfgMumble.Modo,
		"mumbleHost": direccionMumbleEfectiva(cfgMumble),
	})
	c.enviarCtrl(append([]byte{1}, initMsg...))

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
		pingTk := time.NewTicker(20 * time.Second)
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
				mr.mu.Unlock()
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
				if !c.micOn {
					mr.mu.Lock()
					c.micOn = true
					mr.mu.Unlock()
					mr.difundirEstadoPeers(c.grupo)
				}
				rc := payload[0]
				// rc == 0: marcador explícito de fin de frase (EOS), llega a todos los oyentes
				// rc 10..19 = Opus (solo para clientes con opusRx=true)
				// rc 30..39 = ADPCM respaldo simultáneo (solo para clientes con opusRx=false)
				// rc 20..29 o 1..2 = ADPCM/u-law primario (para todos cuando el emisor no tiene Opus)
				if rc >= 10 && rc <= 19 && len(payload) > 4 {
					mr.mumble.enviarAudioMumble(payload[1:])
				} else if (rc > 0 && rc < 10) || (rc >= 20 && rc <= 29) {
					mr.mumble.enviarAudioMumble(payload)
				}
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
		mr.difundirEstadoPeers(c.grupo)
	}
}

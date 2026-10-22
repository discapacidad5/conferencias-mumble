package main

import (
	"sort"
	"sync"
	"time"
)

type Asiento struct {
	Identidad string `json:"identidad,omitempty"`
	Nombre    string `json:"nombre,omitempty"`
	Bloqueo   int    `json:"bloqueo"` // 0=libre, 1=solo moderadores, 2=nadie
}

type ColaItem struct {
	Identidad string `json:"identidad"`
	Nombre    string `json:"nombre"`
	Ts        int64  `json:"ts"`
}

type Mano struct {
	Identidad string `json:"identidad"`
	Nombre    string `json:"nombre"`
	Ts        int64  `json:"ts"`
	Aprobada  bool   `json:"aprobada"`
}

type Documento struct {
	Tipo   string `json:"tipo"` // pdf | imagen | video | audio | web
	URL    string `json:"url"`
	Titulo string `json:"titulo"`
}

// EstadoSala es el estado de UNA sala (la principal o una de discusión).
type EstadoSala struct {
	Asientos     [9]Asiento `json:"asientos"`             // asientos[0] = asiento 1 (solo moderadores)
	Palabra      string     `json:"palabra"`              // identidad que tiene la palabra
	PalabraFin   int64      `json:"palabraFin,omitempty"` // unix ms; 0 = sin límite
	Cola         []ColaItem `json:"cola"`
	Manos        []Mano     `json:"manos"`
	Silencio     bool       `json:"silencio"`     // true = la audiencia (no sentada) no puede hablar
	MicAsientos  bool       `json:"micAsientos"`  // true = los sentados (salvo el asiento 1) deben pedir la palabra
	CamAudiencia bool       `json:"camAudiencia"` // mantenido por compatibilidad de UI (en modo Mumble solo Asiento 1 y Palabra tienen cámara)
	CamAsientos  bool       `json:"camAsientos"`  // mantenido por compatibilidad de UI
	ChatOff      bool       `json:"chatOff"`      // true = solo los moderadores escriben en el chat
	VistaFija    bool       `json:"vistaFija"`    // true = la audiencia solo ve la vista sincronizada
	Rejilla      string     `json:"rejilla"`
	AudioPerfil  string     `json:"audioPerfil"` // "telefono" | "voz" | "musica" — preset de voz Mumble
	Doc          *Documento `json:"doc,omitempty"`
	Moderadores  []string   `json:"moderadores"` // espejo de salaViva.moderadores al serializar

	votantes map[string]int8 // identidad -> 1 a favor / -1 en contra
}

type GrupoInfo struct {
	Id       int    `json:"id"`
	Nombre   string `json:"nombre"`
	DurMin   int    `json:"durMin"`        // minutos configurados (0 = sin límite)
	Iniciado bool   `json:"iniciado"`      // el reloj corre solo tras "comenzar"
	Fin      int64  `json:"fin,omitempty"` // unix ms; 0 = sin límite/sin iniciar
}

type Evento struct {
	Tipo      string `json:"tipo"`
	Identidad string `json:"identidad,omitempty"`
	Asiento   int    `json:"asiento,omitempty"`
	Extra     string `json:"extra,omitempty"`
	Destino   string `json:"destino,omitempty"` // si no vacío, solo esa identidad reacciona
}

// salaViva: estados por grupo + suscriptores SSE
type salaViva struct {
	mu               sync.Mutex
	nombre           string
	estados          map[int]*EstadoSala     // 0 = sala principal
	grupoDe          map[string]int          // identidad -> grupo
	nombres          map[string]string       // identidad -> nombre visible
	grupos           map[int]*GrupoInfo      // id > 0
	plan             map[int]map[string]bool // id -> identidades planificadas
	proxGrupo        int
	moderadores      []string
	modsFijos        map[string]string // identidad -> nombre (delegados, persistidos)
	admins           map[string]bool   // identidades con RoomAdmin (para la corona 👑)
	baneados         map[string]int64  // slug(nombre) o identidad -> expira unix ms
	invitaciones     map[string]string // identidad -> "sentar" | "palabra"
	tiempoInvitacion map[string]int
	micBloq          map[string]bool     // micro bloqueado por moderación
	camBloq          map[string]bool     // cámara bloqueada por moderación
	chatBloq         map[string]bool     // chat prohibido por moderación
	pantallaBloq     map[string]bool     // compartir pantalla prohibido por moderación
	docBloq          map[string]bool     // compartir documentos prohibido por moderación
	lobby            map[string]ColaItem // quienes esperan admisión (sala de espera)
	lobbyOk          map[string]bool     // identidades admitidas desde el lobby
	lobbyNo          map[string]int64    // identidad o "n:slug" rechazada -> cuándo (10 min)
	micOk            map[string]bool     // excepción individual sobre los bloqueos de sala
	camOk            map[string]bool     // excepción individual de cámara
	ultTiempoPalabra int                 // última duración usada (segundos)
	ausente          map[string]int64    // identidad -> desde cuándo falta (margen para recargas)
	cerradaHasta     int64               // unix ms: tras "terminar reunión" nadie sin rol reingresa
	presentes        map[string]int      // identidad -> grupo donde está conectada
	subs             map[chan []byte]string
}

type Hub struct {
	mu    sync.Mutex
	salas map[string]*salaViva
}

func NewHub() *Hub {
	return &Hub{salas: map[string]*salaViva{}}
}

func nuevoEstado() *EstadoSala {
	// En la edición Mumble para conexiones lentas, por defecto CamAudiencia y
	// CamAsientos nacen en true (solo Asiento 1 y Palabra publican video).
	return &EstadoSala{
		Rejilla:      "asientos",
		VistaFija:    true,
		AudioPerfil:  "telefono",
		CamAudiencia: true,
		CamAsientos:  true,
		votantes:     map[string]int8{},
	}
}

func limpiarVotos(e *EstadoSala) { e.votantes = map[string]int8{} }

func (h *Hub) sala(nombre string) *salaViva {
	h.mu.Lock()
	defer h.mu.Unlock()
	sv, ok := h.salas[nombre]
	if !ok {
		sv = &salaViva{
			nombre:           nombre,
			estados:          map[int]*EstadoSala{0: nuevoEstado()},
			grupoDe:          map[string]int{},
			nombres:          map[string]string{},
			grupos:           map[int]*GrupoInfo{},
			plan:             map[int]map[string]bool{},
			baneados:         map[string]int64{},
			invitaciones:     map[string]string{},
			tiempoInvitacion: map[string]int{},
			micBloq:          map[string]bool{},
			camBloq:          map[string]bool{},
			chatBloq:         map[string]bool{},
			pantallaBloq:     map[string]bool{},
			docBloq:          map[string]bool{},
			lobby:            map[string]ColaItem{},
			lobbyOk:          map[string]bool{},
			lobbyNo:          map[string]int64{},
			micOk:            map[string]bool{},
			camOk:            map[string]bool{},
			admins:           map[string]bool{},
			ausente:          map[string]int64{},
			presentes:        map[string]int{},
			modsFijos:        map[string]string{},
			subs:             map[chan []byte]string{},
		}
		if sl := store.BuscarSala(nombre); sl != nil {
			for id, nom := range sl.ModsFijos {
				sv.modsFijos[id] = nom
			}
		}
		h.salas[nombre] = sv
	}
	return sv
}

func (h *Hub) suscribir(nombre, identidad string) chan []byte {
	sv := h.sala(nombre)
	ch := make(chan []byte, 16)
	sv.mu.Lock()
	sv.subs[ch] = identidad
	sv.mu.Unlock()
	return ch
}

func (h *Hub) desuscribir(nombre string, ch chan []byte) {
	sv := h.sala(nombre)
	sv.mu.Lock()
	delete(sv.subs, ch)
	sv.mu.Unlock()
}

func (sv *salaViva) broadcast(ev *Evento) {
	for ch, id := range sv.subs {
		b, err := marshalEstadoPara(sv, ev, id)
		if err != nil {
			continue
		}
		select {
		case ch <- b:
		default:
		}
	}
}

// --- estado por grupo ---

func (sv *salaViva) estadoDe(id string) *EstadoSala {
	g := sv.grupoDe[id]
	e, ok := sv.estados[g]
	if !ok {
		e = nuevoEstado()
		sv.estados[g] = e
	}
	return e
}

func sacarDeEstado(e *EstadoSala, id string) int {
	idx := asientoEn(e, id)
	if idx >= 0 {
		e.Asientos[idx].Identidad, e.Asientos[idx].Nombre = "", ""
	}
	e.Cola = filtrarCola(e.Cola, id)
	e.Manos = filtrarManos(e.Manos, id)
	if e.Palabra == id {
		e.Palabra = ""
		e.PalabraFin = 0
		limpiarVotos(e)
	}
	return idx
}

func (sv *salaViva) moverAGrupo(id string, g int) {
	antes := sv.grupoDe[id]
	if antes == g {
		return
	}
	if e, ok := sv.estados[antes]; ok {
		if idx := sacarDeEstado(e, id); idx >= 0 {
			sv.rellenarColaSiPuede(e, idx)
		}
	}
	sv.grupoDe[id] = g
	if _, ok := sv.estados[g]; !ok {
		sv.estados[g] = nuevoEstado()
	}
}

func (sv *salaViva) crearGrupo(nombre string, minutos int) int {
	sv.proxGrupo++
	g := &GrupoInfo{Id: sv.proxGrupo, Nombre: nombre, DurMin: minutos}
	sv.grupos[g.Id] = g
	sv.estados[g.Id] = nuevoEstado()
	sv.plan[g.Id] = map[string]bool{}
	return g.Id
}

func (sv *salaViva) comenzarGrupo(gid int) {
	g, ok := sv.grupos[gid]
	if !ok || g.Iniciado {
		return
	}
	g.Iniciado = true
	if g.DurMin > 0 {
		g.Fin = ahora() + int64(g.DurMin)*60000
	}
	for id := range sv.plan[gid] {
		sv.moverAGrupo(id, gid)
	}
	sv.plan[gid] = map[string]bool{}
}

func (sv *salaViva) cerrarGrupo(gid int) {
	g, ok := sv.grupos[gid]
	if !ok {
		return
	}
	g.Iniciado = false
	g.Fin = 0
	if sv.plan[gid] == nil {
		sv.plan[gid] = map[string]bool{}
	}
	for _, m := range sv.miembrosDe(gid) {
		sv.plan[gid][m.Identidad] = true
		sv.moverAGrupo(m.Identidad, 0)
	}
}

func (sv *salaViva) borrarGrupo(gid int) {
	for id := range sv.plan[gid] {
		delete(sv.plan[gid], id)
	}
	for _, m := range sv.miembrosDe(gid) {
		sv.moverAGrupo(m.Identidad, 0)
	}
	delete(sv.plan, gid)
	delete(sv.grupos, gid)
	delete(sv.estados, gid)
}

func (sv *salaViva) disolverGrupos() {
	for id := range sv.grupoDe {
		sv.moverAGrupo(id, 0)
	}
	sv.grupos = map[int]*GrupoInfo{}
	sv.plan = map[int]map[string]bool{}
	for g := range sv.estados {
		if g != 0 {
			delete(sv.estados, g)
		}
	}
}

func (sv *salaViva) miembrosDe(g int) []ColaItem {
	out := []ColaItem{}
	for id, gg := range sv.grupoDe {
		if gg == g {
			out = append(out, ColaItem{Identidad: id, Nombre: sv.nombres[id]})
		}
	}
	return out
}

func (sv *salaViva) gruposJSON() []any {
	out := []any{}
	ids := make([]int, 0, len(sv.grupos))
	for id := range sv.grupos {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	for _, id := range ids {
		g := sv.grupos[id]
		plan := []ColaItem{}
		for pid := range sv.plan[id] {
			plan = append(plan, ColaItem{Identidad: pid, Nombre: sv.nombres[pid]})
		}
		out = append(out, map[string]any{
			"id": g.Id, "nombre": g.Nombre, "fin": g.Fin,
			"durMin": g.DurMin, "iniciado": g.Iniciado,
			"miembros": sv.miembrosDe(id), "plan": plan,
		})
	}
	return out
}

// --- Lógica de asientos y permisos ---

func (sv *salaViva) esModerador(identidad string) bool {
	if _, ok := sv.modsFijos[identidad]; ok {
		return true
	}
	for _, m := range sv.moderadores {
		if m == identidad {
			return true
		}
	}
	return false
}

func (sv *salaViva) staffPresente() bool {
	for id := range sv.presentes {
		if sv.admins[id] || sv.esModerador(id) {
			return true
		}
	}
	return false
}

func (sv *salaViva) asientoDe(identidad string) int {
	return asientoEn(sv.estadoDe(identidad), identidad)
}

func asientoEn(e *EstadoSala, identidad string) int {
	for i, a := range e.Asientos {
		if a.Identidad == identidad {
			return i
		}
	}
	return -1
}

func enColaEn(e *EstadoSala, identidad string) bool {
	for _, c := range e.Cola {
		if c.Identidad == identidad {
			return true
		}
	}
	return false
}

func (sv *salaViva) puedeSentarse(e *EstadoSala, id string, idx int, esAdmin bool) bool {
	if idx == 0 && !(esAdmin || sv.esModerador(id)) {
		return false
	}
	switch e.Asientos[idx].Bloqueo {
	case 2:
		return false
	case 1:
		return esAdmin || sv.esModerador(id)
	}
	return true
}

func liberarAsientoEn(e *EstadoSala, idx int) string {
	a := &e.Asientos[idx]
	expulsado := a.Identidad
	a.Identidad, a.Nombre = "", ""
	return expulsado
}

func filtrarCola(cola []ColaItem, id string) []ColaItem {
	out := cola[:0]
	for _, c := range cola {
		if c.Identidad != id {
			out = append(out, c)
		}
	}
	return out
}

func filtrarManos(manos []Mano, id string) []Mano {
	out := manos[:0]
	for _, m := range manos {
		if m.Identidad != id {
			out = append(out, m)
		}
	}
	return out
}

func (sv *salaViva) quitarDeCola(e *EstadoSala, id string) {
	e.Cola = filtrarCola(e.Cola, id)
}

func (sv *salaViva) quitarMano(e *EstadoSala, id string) {
	e.Manos = filtrarManos(e.Manos, id)
}

func (sv *salaViva) quitarModerador(id string) {
	out := sv.moderadores[:0]
	for _, m := range sv.moderadores {
		if m != id {
			out = append(out, m)
		}
	}
	sv.moderadores = out
	if _, ok := sv.modsFijos[id]; ok {
		delete(sv.modsFijos, id)
		store.QuitarMod(sv.nombre, id)
	}
}

func (sv *salaViva) rellenarColaSiPuede(e *EstadoSala, idx int) string {
	a := &e.Asientos[idx]
	if a.Identidad != "" {
		return ""
	}
	for i, c := range e.Cola {
		if sv.puedeSentarse(e, c.Identidad, idx, false) {
			a.Identidad, a.Nombre = c.Identidad, c.Nombre
			e.Cola = append(e.Cola[:i], e.Cola[i+1:]...)
			return c.Identidad
		}
	}
	return ""
}

func (sv *salaViva) asientoLibreEn(e *EstadoSala, id string, soyMod bool) int {
	for i := 0; i < 9; i++ {
		if e.Asientos[i].Identidad == "" && sv.puedeSentarse(e, id, i, soyMod) {
			return i
		}
	}
	return -1
}

// puedeMic decide si la identidad puede publicar micrófono en este instante.
func (sv *salaViva) puedeMic(id string, _ bool) bool {
	if sv.micBloq[id] {
		return false
	}
	e := sv.estadoDe(id)
	if e.Palabra == id {
		return true
	}
	if sv.micOk[id] {
		return true
	}
	if idx := asientoEn(e, id); idx >= 0 {
		if idx == 0 {
			return true
		}
		return !e.MicAsientos
	}
	return !e.Silencio
}

// puedeCam: en la versión Mumble para conexiones lentas, SOLO el Asiento 1
// (anfitrión) y quien tiene La Palabra pueden encender cámara (o excepción
// explícita de moderador), garantizando máximo 2 cámaras de bajo consumo.
func (sv *salaViva) puedeCam(id string) bool {
	if sv.camBloq[id] {
		return false
	}
	e := sv.estadoDe(id)
	if e.Palabra == id || asientoEn(e, id) == 0 {
		return true
	}
	return sv.camOk[id]
}

// puedePantalla: SOLO el asiento del anfitrión (el 1) o quien tiene la palabra.
func (sv *salaViva) puedePantalla(id string) bool {
	if sv.pantallaBloq[id] {
		return false
	}
	e := sv.estadoDe(id)
	return e.Palabra == id || asientoEn(e, id) == 0
}

// puedeDoc: misma regla que la pantalla pero para compartir documentos.
func (sv *salaViva) puedeDoc(id string) bool {
	if sv.docBloq[id] {
		return false
	}
	e := sv.estadoDe(id)
	return e.Palabra == id || asientoEn(e, id) == 0
}

func ahora() int64 { return time.Now().UnixMilli() }

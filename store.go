package main

import (
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"sync"

	"golang.org/x/crypto/bcrypt"
)

type Admin struct {
	Usuario string `json:"usuario"`
	Hash    string `json:"hash"`
}

// MumbleConfig define a qué servidor Mumble se conecta la plataforma:
// Modo "local" usa el mumble-server local (MUMBLE_LOCAL_ADDR, por defecto
// localhost:64738 o mumble-server:64738 en Docker); Modo "remoto" conecta a
// cualquier servidor Mumble público o privado en Internet.
type MumbleConfig struct {
	Modo      string `json:"modo"`                // "local" | "remoto"
	Host      string `json:"host"`                // ej: "mumble.ejemplo.org"
	Puerto    int    `json:"puerto"`              // por defecto 64738
	Clave     string `json:"clave,omitempty"`     // contraseña del servidor Mumble si requiere
	CanalRaiz string `json:"canalRaiz,omitempty"` // canal base opcional en el servidor Mumble
}

type Sala struct {
	Nombre        string            `json:"nombre"`
	Privada       bool              `json:"privada"`
	Hash          string            `json:"hash"` // bcrypt de la clave de sala (vacío si pública)
	Creador       string            `json:"creador"`
	CreadaEn      int64             `json:"creadaEn"`
	Acceso        string            `json:"acceso,omitempty"`    // "" | "admin" | "lobby" — quién entra directo
	ModsFijos     map[string]string `json:"modsFijos,omitempty"` // identidad -> nombre (moderadores delegados)
	Deshabilitada bool              `json:"deshabilitada,omitempty"`
	NombreVisible string            `json:"nombreVisible,omitempty"`
}

// Visible: el nombre para mostrar — NombreVisible si hay, si no el slug.
func (sl Sala) Visible() string {
	if sl.NombreVisible != "" {
		return sl.NombreVisible
	}
	return sl.Nombre
}

type datos struct {
	Admins []Admin      `json:"admins"`
	Salas  []Sala       `json:"salas"`
	Mumble MumbleConfig `json:"mumble"`
}

// Store: base de datos embebida, persistida en DATA_DIR/datos.json
type Store struct {
	mu   sync.Mutex
	path string
	d    datos
}

func NewStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	s := &Store{path: filepath.Join(dir, "datos.json")}
	if b, err := os.ReadFile(s.path); err == nil {
		if err := json.Unmarshal(b, &s.d); err != nil {
			return nil, err
		}
	}
	if s.d.Mumble.Modo == "" {
		if m := os.Getenv("MUMBLE_MODE"); m == "remoto" || m == "local" {
			s.d.Mumble.Modo = m
		} else {
			s.d.Mumble.Modo = "local"
		}
		if h := os.Getenv("MUMBLE_REMOTE_HOST"); h != "" {
			s.d.Mumble.Host = h
		}
		if k := os.Getenv("MUMBLE_REMOTE_PASSWORD"); k != "" {
			s.d.Mumble.Clave = k
		}
	}
	if s.d.Mumble.Puerto <= 0 {
		s.d.Mumble.Puerto = 64738
	}
	return s, nil
}

func (s *Store) guardar() {
	b, _ := json.MarshalIndent(s.d, "", "  ")
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		log.Printf("error guardando store: %v", err)
		return
	}
	os.Rename(tmp, s.path)
}

// --- Configuración Mumble ---

func (s *Store) ObtenerMumble() MumbleConfig {
	s.mu.Lock()
	defer s.mu.Unlock()
	cfg := s.d.Mumble
	if cfg.Modo == "" {
		cfg.Modo = "local"
	}
	if cfg.Puerto <= 0 {
		cfg.Puerto = 64738
	}
	return cfg
}

func (s *Store) GuardarMumble(cfg MumbleConfig) MumbleConfig {
	s.mu.Lock()
	defer s.mu.Unlock()
	if cfg.Modo != "remoto" {
		cfg.Modo = "local"
	}
	if cfg.Puerto <= 0 || cfg.Puerto > 65535 {
		cfg.Puerto = 64738
	}
	s.d.Mumble = cfg
	s.guardar()
	return cfg
}

// --- Administradores ---

func (s *Store) CrearAdmin(usuario, clave string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, a := range s.d.Admins {
		if a.Usuario == usuario {
			return errors.New("el usuario ya existe")
		}
	}
	h, err := bcrypt.GenerateFromPassword([]byte(clave), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	s.d.Admins = append(s.d.Admins, Admin{Usuario: usuario, Hash: string(h)})
	s.guardar()
	return nil
}

func (s *Store) VerificarAdmin(usuario, clave string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, a := range s.d.Admins {
		if a.Usuario == usuario {
			return bcrypt.CompareHashAndPassword([]byte(a.Hash), []byte(clave)) == nil
		}
	}
	return false
}

// --- Moderadores delegados (persisten entre reinicios) ---

func (s *Store) FijarMod(sala, identidad, nombre string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.d.Salas {
		if s.d.Salas[i].Nombre == sala {
			if s.d.Salas[i].ModsFijos == nil {
				s.d.Salas[i].ModsFijos = map[string]string{}
			}
			s.d.Salas[i].ModsFijos[identidad] = nombre
			s.guardar()
			return
		}
	}
}

func (s *Store) QuitarMod(sala, identidad string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.d.Salas {
		if s.d.Salas[i].Nombre == sala {
			delete(s.d.Salas[i].ModsFijos, identidad)
			s.guardar()
			return
		}
	}
}

func (s *Store) FijarAcceso(sala, acceso string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.d.Salas {
		if s.d.Salas[i].Nombre == sala {
			s.d.Salas[i].Acceso = acceso
			s.guardar()
			return
		}
	}
}

// --- Salas ---

var ErrSalaExiste = errors.New("la sala ya existe")

func (s *Store) CrearSala(nombre, clave, creador string, creadaEn int64) (*Sala, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, sl := range s.d.Salas {
		if sl.Nombre == nombre {
			return nil, ErrSalaExiste
		}
	}
	sl := Sala{Nombre: nombre, Creador: creador, CreadaEn: creadaEn}
	if clave != "" {
		h, err := bcrypt.GenerateFromPassword([]byte(clave), bcrypt.DefaultCost)
		if err != nil {
			return nil, err
		}
		sl.Privada = true
		sl.Hash = string(h)
	}
	s.d.Salas = append(s.d.Salas, sl)
	s.guardar()
	cp := sl
	return &cp, nil
}

func (s *Store) BuscarSala(nombre string) *Sala {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, sl := range s.d.Salas {
		if sl.Nombre == nombre {
			cp := sl
			return &cp
		}
	}
	return nil
}

func (s *Store) ListarSalas() []Sala {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Sala, len(s.d.Salas))
	copy(out, s.d.Salas)
	return out
}

func (s *Store) FijarNombreVisible(nombre, visible string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.d.Salas {
		if s.d.Salas[i].Nombre == nombre {
			s.d.Salas[i].NombreVisible = visible
			s.guardar()
			return
		}
	}
}

func (s *Store) FijarDeshabilitada(nombre string, off bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.d.Salas {
		if s.d.Salas[i].Nombre == nombre {
			s.d.Salas[i].Deshabilitada = off
			s.guardar()
			return
		}
	}
}

func (s *Store) BorrarSala(nombre string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	keep := s.d.Salas[:0]
	for _, sl := range s.d.Salas {
		if sl.Nombre != nombre {
			keep = append(keep, sl)
		}
	}
	s.d.Salas = keep
	s.guardar()
}

func (s *Store) ClaveSalaOK(sl *Sala, clave string) bool {
	if !sl.Privada {
		return true
	}
	return bcrypt.CompareHashAndPassword([]byte(sl.Hash), []byte(clave)) == nil
}

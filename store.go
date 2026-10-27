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
	// Segundos que debe llevar hablando quien tiene el piso antes de que cada
	// rol pueda tumbárselo. PisoCfgOK=false => valores por defecto (0/0/10/60).
	PisoIntAdminSeg     int  `json:"pisoIntAdminSeg"`
	PisoIntAnfitrionSeg int  `json:"pisoIntAnfitrionSeg"`
	PisoIntPalabraSeg   int  `json:"pisoIntPalabraSeg"`
	PisoIntUsuarioSeg   int  `json:"pisoIntUsuarioSeg"`
	PisoCfgOK           bool `json:"pisoCfgOK,omitempty"`
}

// Visible: el nombre para mostrar — NombreVisible si hay, si no el slug.
func (sl Sala) Visible() string {
	if sl.NombreVisible != "" {
		return sl.NombreVisible
	}
	return sl.Nombre
}

type datos struct {
	Admins []Admin `json:"admins"`
	Salas  []Sala  `json:"salas"`
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

// FijarPisoCfg guarda los 4 tiempos de interrupción de piso de una sala
// (admin, anfitrión, palabra, usuario — en segundos, 0 = inmediato).
func (s *Store) FijarPisoCfg(nombre string, admin, anfitrion, palabra, usuario int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	clamp := func(v int) int {
		if v < 0 {
			return 0
		}
		if v > 3600 {
			return 3600
		}
		return v
	}
	for i := range s.d.Salas {
		if s.d.Salas[i].Nombre == nombre {
			s.d.Salas[i].PisoIntAdminSeg = clamp(admin)
			s.d.Salas[i].PisoIntAnfitrionSeg = clamp(anfitrion)
			s.d.Salas[i].PisoIntPalabraSeg = clamp(palabra)
			s.d.Salas[i].PisoIntUsuarioSeg = clamp(usuario)
			s.d.Salas[i].PisoCfgOK = true
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

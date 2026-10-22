# Conferencias con Protocolo Mumble + Video Ligero (Asiento 1 y Palabra)

Edición ultraligera de la plataforma de conferencias diseñada para funcionar sin fallos en **conexiones móviles lentas (2G/3G/4G)** y detrás de **Cloudflare Tunnel (sin IP pública, sin puertos UDP ni servidores TURN)**.

## Características principales

1. **Protocolo Mumble (Servidor Local o Público Remoto)**:
   - Desde el **Panel de Administración** puedes elegir en vivo si las salas se conectan a:
     - **Servidor Mumble Local** (`mumble-server` incluido en `docker-compose.yml`, ~15 MB de RAM).
     - **Cualquier servidor Mumble público o remoto en Internet** (`host:puerto`, contraseña opcional) con botón **🔌 Probar conexión**.
2. **Cero fallos ICE/TURN en datos móviles**:
   - Los teléfonos se conectan únicamente por **WebSocket sobre HTTPS (puerto 443)** pasando directo por tu túnel o proxy inverso.
   - Audio con **Detector de Actividad de Voz (VAD)** (0 bytes/s en silencio) y compresión ultraligera (8–12 kHz µ-law).
3. **Video Ligero 240p exclusivo para Asiento 1 (Anfitrión) y La Palabra**:
   - Solo quien ocupa el **Asiento 1** o tiene **La Palabra** transmite cámara (máximo 2 cámaras en toda la sala, 240p a 10 fps).
   - El servidor Go **no recodifica video (0% gasto de CPU)** y aplica descarte automático de cuadros antiguos (*drop-oldest-frame*) para oyentes con internet lento, de modo que la voz jamás se corta ni se desincroniza.
4. **Interfaz completa conservada**:
   - 9 asientos moderados, área de La Palabra con temporizador, levantar la mano, cola de espera, salas de discusión (breakout rooms), chat, pizarra colaborativa y documentos compartidos (PDF, imágenes, audio, video y web).

## Despliegue con Docker Compose

```bash
cd mumble-conferencias
docker compose up -d --build
```

## Ejecución directa en local (sin Docker)

```bash
cd mumble-conferencias
go build -o conferencia-mumble.exe .
./conferencia-mumble.exe
```

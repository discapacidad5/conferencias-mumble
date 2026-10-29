# Conferencias — Servidor Propio de Voz + Video Ligero (Asiento 1 y Palabra)

Edición ultraligera de la plataforma de conferencias diseñada para funcionar sin fallos en **conexiones móviles lentas (2G/3G/4G)** y detrás de **Cloudflare Tunnel (sin IP pública, sin puertos UDP ni servidores TURN)**.

## Características principales

1. **Servidor de voz propio (un solo binario Go)**:
   - No depende de ningún servicio externo: el mismo proceso sirve la web, el WebSocket y el historial de audio.
   - **Voz por ráfagas HTTP (modelo pull, anti Head-of-Line)**: el micrófono se sube en trozos de ~1 s por `POST /api/salas/{sala}/audio/subir` — cada trozo viaja por su propia conexión, así un trozo atascado se reintenta por otra sin frenar a los demás. El servidor archiva todo en orden por número de trama (`tx`) y solo avisa por el WebSocket con mensajes diminutos (`seg_ini`, `chunk`, `seg_fin`, `falta`); los oyentes descargan la racha contigua por `GET /api/salas/{sala}/audio/{seq}/tramos?desde=N` y la reproducen en orden estricto — si llega el trozo 3 antes que el 2, el 3 espera al 2. Video ligero y compartición siguen por el WebSocket binario.
   - **Voz confiable estilo nota de voz**: cada frase se archiva en el servidor como segmento recuperable (`DATA_DIR/audio/<sala>/`); las piezas faltantes se re-piden al emisor (`falta`) que las re-sube por otro POST, y el cliente vuelve a pedir cualquier tramo que no llegue — el audio llega siempre, aunque tarde.
   - **Piso exclusivo (PTT)**: solo una persona habla a la vez, con tiempos de interrupción configurables por rol (administrador, anfitrión, La Palabra, usuario).
   - **Historial de voz en el chat**: cada intervención queda como nota de voz re-escuchable, con retención configurable.
2. **Cero fallos ICE/TURN en datos móviles**:
   - Los teléfonos se conectan únicamente por **WebSocket sobre HTTPS (puerto 443)** pasando directo por tu túnel o proxy inverso.
   - Audio con **Detector de Actividad de Voz (VAD)** (0 bytes/s en silencio) y compresión ultraligera (Opus ~10–26 kbps, con ADPCM de reserva).
3. **Video Ligero 240p exclusivo para Asiento 1 (Anfitrión) y La Palabra**:
   - Solo quien ocupa el **Asiento 1** o tiene **La Palabra** transmite cámara (máximo 2 cámaras en toda la sala, 240p a 10 fps).
   - El servidor Go **no recodifica video (0% gasto de CPU)** y aplica descarte automático de cuadros antiguos (*drop-oldest-frame*) para oyentes con internet lento, de modo que la voz jamás se corta ni se desincroniza.
4. **Interfaz completa conservada**:
   - 9 asientos moderados, área de La Palabra con temporizador, levantar la mano, cola de espera, salas de discusión (breakout rooms), chat, pizarra colaborativa y documentos compartidos (PDF, imágenes, audio, video y web).

## Despliegue con Docker Compose

```bash
docker compose up -d --build
```

## Ejecución directa en local (sin Docker)

```bash
go build -o conferencia.exe .
./conferencia.exe
```

Variables de entorno: `PORT` (3000), `DATA_DIR` (./data), `APP_SECRET`, `ADMIN_USER`, `ADMIN_PASSWORD`, `PUBLIC_HOST`.

/* ============================================================================
 * Motor de voz propio (WebSocket HTTPS/443) para Conferencias en Conexiones Lentas
 * Sustituye el SDK WebRTC de LiveKit por un único túnel WebSocket (puerto 443)
 * con voz ultraligera (µ-law + VAD) y video 240p exclusivo para Asiento 1 y
 * La Palabra, sin requerir UDP, STUN ni TURN.
 * ============================================================================ */
(function () {
  'use strict';

  const FRAME_AUDIO = 0x01;
  const FRAME_VIDEO = 0x02;
  const FRAME_SCREEN = 0x03;
  const FRAME_AUDIO_SHARE = 0x04;

  const RoomEvent = {
    TrackSubscribed: 'TrackSubscribed',
    TrackUnsubscribed: 'TrackUnsubscribed',
    TrackMuted: 'TrackMuted',
    TrackUnmuted: 'TrackUnmuted',
    LocalTrackPublished: 'LocalTrackPublished',
    LocalTrackUnpublished: 'LocalTrackUnpublished',
    ParticipantPermissionsChanged: 'ParticipantPermissionsChanged',
    ParticipantConnected: 'ParticipantConnected',
    ParticipantDisconnected: 'ParticipantDisconnected',
    ConnectionStateChanged: 'ConnectionStateChanged',
    ConnectionQualityChanged: 'ConnectionQualityChanged',
    ActiveSpeakersChanged: 'ActiveSpeakersChanged',
    DataReceived: 'DataReceived',
    Disconnected: 'Disconnected',
  };

  const TrackSource = {
    Camera: 'camera',
    Microphone: 'microphone',
    ScreenShare: 'screen_share',
    ScreenShareAudio: 'screen_share_audio',
  };

  const ConnectionQuality = {
    Excellent: 'excellent',
    Good: 'good',
    Poor: 'poor',
    Lost: 'lost',
  };

  const DisconnectReason = {
    CLIENT_INITIATED: 1,
    DUPLICATE_IDENTITY: 2,
    PARTICIPANT_REMOVED: 4,
  };

  const VideoPresets = {
    h540: { resolution: { width: 320, height: 240 } },
  };

  const AudioPresets = {
    telephone: { maxBitrate: 10000, tier: 'telefono' }, // ~10 kbps Opus / 24 kbps ADPCM (ahorro extremo 2G/3G y salas de +500 personas)
    speech: { maxBitrate: 18000, tier: 'voz' },         // ~18 kbps Opus / 32 kbps ADPCM (voz nítida equilibrada)
    musicStereo: { maxBitrate: 28000, tier: 'musica' }, // ~28 kbps Opus / 48 kbps ADPCM (alta nitidez HD en buena conexión)
  };

  // --- Detección de soporte nativo WebCodecs Opus (Chrome/Android/Edge/Firefox/Safari moderno) ---
  let SOPORTE_OPUS_RX = false;
  let SOPORTE_OPUS_TX = false;
  const promesaDeteccionOpus = (async function detectarOpus() {
    try {
      if (typeof window.AudioDecoder === 'function' && typeof window.EncodedAudioChunk === 'function') {
        const resRx = await window.AudioDecoder.isConfigSupported({
          codec: 'opus',
          sampleRate: 48000,
          numberOfChannels: 1,
        });
        if (resRx && resRx.supported) {
          const dec = new window.AudioDecoder({ output: () => {}, error: () => {} });
          dec.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });
          dec.close();
          SOPORTE_OPUS_RX = true;
        }
      }
    } catch {}
    try {
      if (typeof window.AudioEncoder === 'function' && typeof window.AudioData === 'function') {
        const resTx = await window.AudioEncoder.isConfigSupported({
          codec: 'opus',
          sampleRate: 48000,
          numberOfChannels: 1,
          bitrate: 18000,
        });
        if (resTx && resTx.supported) {
          SOPORTE_OPUS_TX = true;
        }
      }
    } catch {}
  })();

  // --- Tablas IMA-ADPCM (4 bits por muestra + pre-énfasis de voz) ---
  const ADPCM_INDEX_TABLE = new Int8Array([
    -1, -1, -1, -1, 2, 4, 6, 8,
    -1, -1, -1, -1, 2, 4, 6, 8,
  ]);
  const ADPCM_STEP_TABLE = new Int16Array([
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17,
    19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
    50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
    130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
    337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
    876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
    2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358,
    5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
    15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
  ]);

  // Codifica un bloque Float32 en IMA-ADPCM limpio (sin saturación IIR) con cabecera
  // de estado y número de secuencia [FRAME_AUDIO, rateCode, seqLo, seqHi, predLo, predHi, stepIdx, 0x5A]
  function codificarBloqueADPCM(samples, state, rateCode, seq) {
    const n = samples.length;
    const outBytes = Math.ceil(n / 2);
    const pkt = new Uint8Array(8 + outBytes);
    pkt[0] = FRAME_AUDIO;
    pkt[1] = rateCode;

    let pred = state.pred | 0;
    let idx = state.idx | 0;
    const s = (seq | 0) & 0xffff;

    // Guardar número de secuencia y estado inicial del predictor para inmunidad ante pérdidas
    pkt[2] = s & 0xff;
    pkt[3] = (s >> 8) & 0xff;
    pkt[4] = pred & 0xff;
    pkt[5] = (pred >> 8) & 0xff;
    pkt[6] = idx & 0xff;
    pkt[7] = 0x5A; // marca de trama ADPCM v2 limpia (con seq, sin distorsión IIR)

    let bytePos = 8;
    let highNibble = false;
    let curByte = 0;

    for (let i = 0; i < n; i++) {
      let x = samples[i];
      // Limitador suave para evitar clipping brusco en picos de micrófono
      if (x > 0.98) x = 0.98;
      else if (x < -0.98) x = -0.98;
      const val = (x * 32767) | 0;

      let step = ADPCM_STEP_TABLE[idx];
      let diff = val - pred;
      let nibble = 0;
      if (diff < 0) {
        nibble = 8;
        diff = -diff;
      }
      let vpdiff = step >> 3;
      if (diff >= step) {
        nibble |= 4;
        diff -= step;
        vpdiff += step;
      }
      step >>= 1;
      if (diff >= step) {
        nibble |= 2;
        diff -= step;
        vpdiff += step;
      }
      step >>= 1;
      if (diff >= step) {
        nibble |= 1;
        vpdiff += step;
      }

      if (nibble & 8) pred -= vpdiff;
      else pred += vpdiff;
      if (pred > 32767) pred = 32767;
      else if (pred < -32768) pred = -32768;

      idx += ADPCM_INDEX_TABLE[nibble];
      if (idx < 0) idx = 0;
      else if (idx > 88) idx = 88;

      if (!highNibble) {
        curByte = nibble & 0x0f;
        highNibble = true;
      } else {
        pkt[bytePos++] = curByte | ((nibble & 0x0f) << 4);
        highNibble = false;
      }
    }
    if (highNibble) {
      pkt[bytePos++] = curByte;
    }
    state.pred = pred;
    state.idx = idx;
    return pkt;
  }

  function decodificarBloqueADPCM(payload) {
    if (payload.length < 5) return { pcm: new Float32Array(0), seq: -1 };
    const esV2 = payload.length >= 7 && payload[6] === 0x5A;
    let seq = -1;
    let pred = 0;
    let idx = 0;
    let dataStart = 5;

    if (esV2) {
      seq = payload[1] | (payload[2] << 8);
      pred = payload[3] | (payload[4] << 8);
      if (pred & 0x8000) pred -= 0x10000;
      idx = payload[5];
      dataStart = 7;
    } else {
      pred = payload[1] | (payload[2] << 8);
      if (pred & 0x8000) pred -= 0x10000;
      idx = payload[3];
      dataStart = 5;
    }
    if (idx < 0) idx = 0;
    else if (idx > 88) idx = 88;

    const dataBytes = payload.length - dataStart;
    if (dataBytes <= 0) return { pcm: new Float32Array(0), seq };
    const numSamples = dataBytes * 2;
    const out = new Float32Array(numSamples);
    let outIdx = 0;

    for (let i = dataStart; i < payload.length; i++) {
      const b = payload[i];
      for (let s = 0; s < 2; s++) {
        const nibble = s === 0 ? (b & 0x0f) : ((b >> 4) & 0x0f);
        const step = ADPCM_STEP_TABLE[idx];
        let vpdiff = step >> 3;
        if (nibble & 4) vpdiff += step;
        if (nibble & 2) vpdiff += step >> 1;
        if (nibble & 1) vpdiff += step >> 2;
        if (nibble & 8) pred -= vpdiff;
        else pred += vpdiff;
        if (pred > 32767) pred = 32767;
        else if (pred < -32768) pred = -32768;

        idx += ADPCM_INDEX_TABLE[nibble];
        if (idx < 0) idx = 0;
        else if (idx > 88) idx = 88;

        out[outIdx++] = pred / 32768.0;
      }
    }
    return { pcm: out, seq };
  }

  // --- Tablas y conversión µ-law (mantenido para retrocompatibilidad) ---
  const ulawDecodeTable = new Float32Array(256);
  (function initUlaw() {
    for (let i = 0; i < 256; i++) {
      let u = ~i & 0xff;
      let sign = u & 0x80;
      let exponent = (u >> 4) & 0x07;
      let mantissa = u & 0x0f;
      let sample = ((mantissa << 3) + 0x84) << exponent;
      sample -= 0x84;
      ulawDecodeTable[i] = (sign ? -sample : sample) / 32768.0;
    }
  })();

  function linearToUlaw(sampleFloat) {
    let s = Math.max(-1, Math.min(1, sampleFloat));
    let pcm = (s * 32767) | 0;
    let sign = (pcm >> 8) & 0x80;
    if (sign !== 0) pcm = -pcm;
    if (pcm > 32635) pcm = 32635;
    pcm += 0x84;
    let exponent = 7;
    for (let expMask = 0x4000; (pcm & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
    let mantissa = (pcm >> (exponent + 3)) & 0x0f;
    return ~(sign | (exponent << 4) | mantissa) & 0xff;
  }

  // Filtro Biquad Butterworth pasa-bajos de 2º orden para eliminar aliasing ("basurita")
  function crearFiltroPasaBajos(sampleRate, cutoffHz) {
    const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
    const cosw0 = Math.cos(w0);
    const sinw0 = Math.sin(w0);
    const alpha = sinw0 / (2 * Math.SQRT1_2);
    const a0 = 1 + alpha;
    const b0 = ((1 - cosw0) / 2) / a0;
    const b1 = (1 - cosw0) / a0;
    const b2 = ((1 - cosw0) / 2) / a0;
    const a1 = (-2 * cosw0) / a0;
    const a2 = (1 - alpha) / a0;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    return function filtrar(x) {
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x;
      y2 = y1; y1 = y;
      return y;
    };
  }

  // Filtro pasa-altos de 1er orden a 85 Hz para quitar retumbo/viento/DC del micrófono
  function crearFiltroPasaAltos85Hz(sampleRate) {
    const rc = 1.0 / (2 * Math.PI * 85);
    const dt = 1.0 / sampleRate;
    const alpha = rc / (rc + dt);
    let xPrev = 0, yPrev = 0;
    return function filtrarHP(x) {
      const y = alpha * (yPrev + x - xPrev);
      xPrev = x;
      yPrev = y;
      return y;
    };
  }

  // Extrae muestras Float32 de un objeto WebCodecs AudioData respetando su
  // formato nativo exacto (s16, s16-planar, f32, f32-planar). En Android Chrome
  // AudioDecoder devuelve 's16' o 's16-planar': pedir conversión implícita en
  // copyTo() corrompe las muestras o produce ruido fuerte.
  function extraerFloat32DeAudioData(audioData) {
    const n = audioData.numberOfFrames;
    const ch = Math.max(1, audioData.numberOfChannels || 1);
    const fmt = String(audioData.format || 'f32-planar');
    if (fmt === 's16-planar') {
      const s16 = new Int16Array(n);
      audioData.copyTo(s16, { planeIndex: 0 });
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = s16[i] / 32768.0;
      return out;
    }
    if (fmt === 's16') {
      const s16 = new Int16Array(n * ch);
      audioData.copyTo(s16, { planeIndex: 0 });
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = s16[i * ch] / 32768.0;
      return out;
    }
    if (fmt === 'f32') {
      const f32 = new Float32Array(n * ch);
      audioData.copyTo(f32, { planeIndex: 0 });
      if (ch === 1) return f32;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = f32[i * ch];
      return out;
    }
    const out = new Float32Array(n);
    audioData.copyTo(out, { planeIndex: 0 });
    return out;
  }

  // Remuestreo con fase continua entre bloques (estado externo en st)
  function remuestrearA(st, samples, inRate, outRate) {
    if (!samples || !samples.length) return new Float32Array(0);
    if (inRate === outRate) {
      st.last = samples[samples.length - 1];
      st.has = true;
      st.phase = 0;
      return samples;
    }
    const nIn = samples.length;
    const step = inRate / outRate;
    if (!st.has) {
      st.last = samples[0];
      st.has = true;
      st.phase = 0;
    }
    const tmp = new Float32Array(Math.ceil((nIn - st.phase) / step) + 2);
    let o = 0;
    while (st.phase < nIn) {
      const idx = st.phase | 0;
      const frac = st.phase - idx;
      const s0 = idx === 0 ? st.last : samples[idx - 1];
      const s1 = samples[idx];
      tmp[o++] = s0 + frac * (s1 - s0);
      st.phase += step;
    }
    st.phase -= nIn;
    st.last = samples[nIn - 1];
    return tmp.subarray(0, o);
  }

  // Parsea un archivo .seg del servidor (cabecera CSEG + tramas crudas).
  // Espejo del formato de segmentos.go: magic+ver, u32 seq, u8 grupo, u8 flags,
  // str de, str nombre, i64 inicioMs, u32 durMs, u32 numFrames,
  // registros [u16 len][payload]. Devuelve {sg, frames} o null.
  function parsearArchivoSeg(b) {
    if (!b || b.length < 21 || b[0] !== 0x43 || b[1] !== 0x53 ||
        b[2] !== 0x45 || b[3] !== 0x47 || b[4] !== 1) return null;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const sg = {
      seq: dv.getUint32(5),
      grupo: b[9],
      cortado: !!(b[10] & 1),
      abierto: !!(b[10] & 2),
    };
    let i = 11;
    const dec = new TextDecoder();
    const leerStr = () => {
      if (i + 2 > b.length) return null;
      const n = dv.getUint16(i);
      i += 2;
      if (i + n > b.length) return null;
      const s = dec.decode(b.subarray(i, i + n));
      i += n;
      return s;
    };
    sg.de = leerStr();
    sg.nombre = leerStr();
    if (sg.de === null || sg.nombre === null || i + 16 > b.length) return null;
    sg.inicio = Number(dv.getBigUint64(i));
    sg.durMs = dv.getUint32(i + 8);
    const nf = dv.getUint32(i + 12);
    i += 16;
    const frames = [];
    for (let k = 0; k < nf; k++) {
      if (i + 2 > b.length) break;
      const n = dv.getUint16(i);
      i += 2;
      if (i + n > b.length) break;
      frames.push(b.slice(i, i + n));
      i += n;
    }
    return { sg, frames };
  }

  // AudioWorklet en hilo de tiempo real (128 muestras = 2.66 ms) para que la
  // reproducción de voz jamás sufra micro-cortes cuando el hilo principal de JS
  // renderiza la interfaz o procesa eventos.
  const WORKLET_RX_CODE = `
class VozRxProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const rate = sampleRate || 48000;
    this.rate = rate;
    this.cap = Math.ceil(rate * 30);
    this.ring = new Float32Array(this.cap);
    this.writePos = 0;
    this.readPosF = 0;
    this.available = 0;
    this.playing = false;
    this.eosPending = false;
    this.waitSamples = 0;
    this.underrunSamples = 0;
    this.lastOut = 0;
    this.fadeInPos = 0;
    this.fadeInLen = Math.ceil(rate * 0.005);
    this.readRate = 1.0;
    this.velMax = 1.0;
    this.targetSamples = Math.ceil(rate * 0.4); // ~400 ms de colchón al arrancar:
                                                // con menos, cualquier jitter de red
                                                // paraba/reanudaba el reproductor (micro-cortes)
    this.capMs = 28;
    this.solaOv = Math.ceil(rate * 0.01);
    this.solaTail = new Float32Array(this.solaOv);
    this.port.onmessage = (ev) => {
      const d = ev.data;
      if (!d) return;
      if (d.t === 'eos') {
        this.eosPending = true;
        return;
      }
      if (d.t === 'limpiar') {
        // "Ir al presente": vaciar todo el audio pendiente sin cortar el nodo
        this.available = 0;
        this.readPosF = this.writePos;
        this.playing = false;
        this.eosPending = false;
        this.waitSamples = 0;
        this.readRate = 1.0;
        return;
      }
      if (d.t === 'vel') {
        // Reproducción siempre 1.0x natural: la aceleración está desactivada
        this.velMax = 1.0;
        this.readRate = 1.0;
        return;
      }
      if (d.t === 'target' && typeof d.ms === 'number') {
        // Colchón autorregulado (hasta 10 s): acumula el trozo completo
        // antes de reproducir para absorber los siguientes baches a 1.0x
        this.targetSamples = Math.ceil(this.rate * (Math.max(100, Math.min(10000, d.ms)) / 1000));
        return;
      }
      if (d.t === 'cap' && typeof d.ms === 'number') {
        this.capMs = Math.max(0.26, Math.min(29, d.ms / 1000));
        return;
      }
      if (d.t === 'push' && d.pcm) {
        const src = d.pcm;
        const n = src.length;
        if (n === 0) return;
        this.eosPending = false;
        const ring = this.ring;
        const cap = this.cap;
        let wp = this.writePos;
        for (let i = 0; i < n; i++) {
          if (this.available < cap) {
            ring[wp] = src[i];
            wp = (wp + 1) % cap;
            this.available++;
          }
        }
        this.writePos = wp;
      }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    const n = out.length;
    if (!this.playing) {
      if (this.available > 0) {
        this.waitSamples += n;
        if (
          this.available >= this.targetSamples ||
          this.eosPending ||
          this.waitSamples >= this.rate * 0.08
        ) {
          this.playing = true;
          this.waitSamples = 0;
          this.underrunSamples = 0;
          this.fadeInPos = 0;
        }
      } else {
        this.waitSamples = 0;
      }
      if (!this.playing) {
        for (let i = 0; i < n; i++) out[i] = 0;
        return true;
      }
    }

    // Reproducción 1:1 a velocidad natural 1.0x (jamás acelera: el colchón
    // acumulado tras el primer bache absorbe los baches siguientes)
    const ring = this.ring;
    const cap = this.cap;
    for (let i = 0; i < n; i++) {
      if (this.available >= 1) {
        const idx0 = this.readPosF | 0;
        let s = ring[idx0];
        this.readPosF = (idx0 + 1) % cap;
        this.available -= 1;
        if (this.fadeInPos < this.fadeInLen) {
          s *= this.fadeInPos / this.fadeInLen;
          this.fadeInPos++;
        }
        out[i] = s;
        this.lastOut = s;
        this.underrunSamples = 0;
      } else {
        this.lastOut *= 0.982;
        if (Math.abs(this.lastOut) < 0.0001) this.lastOut = 0;
        out[i] = this.lastOut;
        this.underrunSamples++;
        // ~500 ms de hueco tolerado con cola amortiguada antes de parar:
        // el tope viejo de 80 ms detenía y reanudaba el reproductor en
        // cada bache de red — cada ciclo sonaba como un micro-corte
        if (this.eosPending || this.underrunSamples > this.rate * 0.5) {
          this.playing = false;
          this.eosPending = false;
          this.waitSamples = 0;
          this.available = 0;
          this.readPosF = this.writePos;
          for (let k = i + 1; k < n; k++) out[k] = 0;
          break;
        }
      }
    }
    return true;
  }

  // SOLA (Synchronized Overlap-Add): emite n muestras consumiendo
  // ~n*readRate del ring, eligiendo por correlación el desfase que mejor
  // encaja cada ventana — así se drena el retraso sin efecto "ardilla".
  _sola(out, n) {
    const ring = this.ring, cap = this.cap, sr = this.rate;
    const ov = this.solaOv;                 // 10 ms de solape
    const win = ov * 2;                     // ventana de 20 ms
    const hopIn = Math.round(ov * this.readRate);
    const sMax = Math.round(sr * 0.009);    // búsqueda ±9 ms
    const tail = this.solaTail;
    let pos = 0;
    // Primera ventana: fundir con la cola de la salida anterior
    let prevOut = tail;
    while (pos + win <= n && this.available >= hopIn + sMax + win) {
      const base = this.readPosF | 0;
      let bestK = 0, bestC = -1e30;
      for (let k = 0; k <= sMax; k += 2) {
        let c = 0;
        for (let j = 0; j < ov; j++) c += prevOut[j] * ring[(base + k + j) % cap];
        if (c > bestC) { bestC = c; bestK = k; }
      }
      for (let j = 0; j < ov; j++) {
        const w = j / ov;
        out[pos + j] = prevOut[j] * (1 - w) + ring[(base + bestK + j) % cap] * w;
      }
      for (let j = ov; j < win; j++) out[pos + j] = ring[(base + bestK + j) % cap];
      pos += ov;
      this.readPosF = (base + bestK + hopIn) % cap;
      this.available -= bestK + hopIn;
      prevOut = out.subarray(pos - ov, pos);
    }
    // Lo que no cupo en ventanas completas se lee lineal (interpolación)
    for (let i = pos; i < n; i++) {
      if (this.available > 1.05) {
        const idx0 = this.readPosF | 0;
        const frac = this.readPosF - idx0;
        const s = ring[idx0] + frac * (ring[(idx0 + 1) % cap] - ring[idx0]);
        this.readPosF = (this.readPosF + this.readRate) % cap;
        this.available -= this.readRate;
        out[i] = s;
        this.lastOut = s;
      } else {
        this.lastOut *= 0.982;
        out[i] = this.lastOut;
        this.underrunSamples++;
      }
    }
    if (this.eosPending && this.available <= 1) {
      this.playing = false;
      this.eosPending = false;
      this.waitSamples = 0;
      this.available = 0;
      this.readPosF = this.writePos;
    }
    if (n >= ov) this.solaTail.set(out.subarray(n - ov));
  }
}
registerProcessor('conferencia-rx-worklet', VozRxProcessor);

class VozTxProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.fill = 0;
  }
  process(inputs) {
    const inp = inputs[0] && inputs[0][0];
    if (!inp || inp.length === 0) return true;
    for (let i = 0; i < inp.length; i++) {
      this.buf[this.fill++] = inp[i];
      if (this.fill === 2048) {
        this.fill = 0;
        const copy = new Float32Array(2048);
        copy.set(this.buf);
        this.port.postMessage(copy, [copy.buffer]);
      }
    }
    return true;
  }
}
registerProcessor('conferencia-tx-worklet', VozTxProcessor);
`;
  let workletBlobUrl = null;
  const ctxWorkletPromesas = new WeakMap();
  function asegurarWorkletEnCtx(ctx) {
    if (!ctx || !ctx.audioWorklet || typeof window.AudioWorkletNode !== 'function') {
      return Promise.resolve(false);
    }
    if (ctxWorkletPromesas.has(ctx)) return ctxWorkletPromesas.get(ctx);
    const p = (async () => {
      try {
        if (!workletBlobUrl) {
          const blob = new Blob([WORKLET_RX_CODE], { type: 'application/javascript' });
          workletBlobUrl = URL.createObjectURL(blob);
        }
        await ctx.audioWorklet.addModule(workletBlobUrl);
        ctx._workletListo = true;
        return true;
      } catch {
        ctx._workletListo = false;
        return false;
      }
    })();
    ctxWorkletPromesas.set(ctx, p);
    return p;
  }

  class Emitter {
    constructor() {
      this._handlers = new Map();
    }
    on(ev, fn) {
      if (!this._handlers.has(ev)) this._handlers.set(ev, new Set());
      this._handlers.get(ev).add(fn);
      return this;
    }
    off(ev, fn) {
      const set = this._handlers.get(ev);
      if (set) set.delete(fn);
      return this;
    }
    emit(ev, ...args) {
      const set = this._handlers.get(ev);
      if (!set) return;
      for (const fn of [...set]) {
        try { fn(...args); } catch (e) { console.error('RoomEvent error:', e); }
      }
    }
  }

  // --- Track remoto o local compatible con track.attach() / track.detach() ---
  class MediaTrack {
    constructor(kind, source, mediaStreamTrack) {
      this.kind = kind; // 'audio' | 'video'
      this.source = source;
      this.mediaStreamTrack = mediaStreamTrack || null;
      this._els = new Set();
      this._canvas = null;
      this._ctx2d = null;
    }

    attach() {
      if (this.kind === 'audio') {
        const el = document.createElement('audio');
        el.autoplay = true;
        el.playsInline = true;
        if (this.mediaStreamTrack) {
          el.srcObject = new MediaStream([this.mediaStreamTrack]);
        }
        this._els.add(el);
        return el;
      }
      // Video local (con mediaStreamTrack directo) vs. Video remoto por canvas/WebSocket
      const el = document.createElement('video');
      el.autoplay = true;
      el.muted = true;
      el.playsInline = true;
      if (this.mediaStreamTrack) {
        el.srcObject = new MediaStream([this.mediaStreamTrack]);
        el.play().catch(() => {});
      } else if (this._canvas && this._canvas.captureStream) {
        el.srcObject = this._canvas.captureStream(12);
        el.play().catch(() => {});
      }
      this._els.add(el);
      return el;
    }

    detach() {
      const out = [...this._els];
      this._els.clear();
      return out;
    }

    stop() {
      if (this.mediaStreamTrack) {
        if (this.mediaStreamTrack._rawStream) {
          try { this.mediaStreamTrack._rawStream.getTracks().forEach(t => t.stop()); } catch {}
        }
        if (this.mediaStreamTrack.stop) {
          try { this.mediaStreamTrack.stop(); } catch {}
        }
      }
    }

    async restartTrack(constraints) {
      if (this._onRestart) {
        return this._onRestart(constraints);
      }
    }
  }

  class TrackPublication {
    constructor(source, track, trackSid, trackName) {
      this.source = source;
      this.track = track;
      this.trackSid = trackSid || ('TR_' + Math.random().toString(36).slice(2, 10));
      this.trackName = trackName || source;
      this.isMuted = false;
      this._onMuteChange = null;
    }
    async mute() {
      this.isMuted = true;
      if (this._onMuteChange) this._onMuteChange(true);
    }
    async unmute() {
      this.isMuted = false;
      if (this._onMuteChange) this._onMuteChange(false);
    }
  }

  class Participant {
    constructor(identity, name, isLocal, room) {
      this.identity = identity || '';
      this.name = name || identity || '';
      this.isLocal = !!isLocal;
      this._room = room;
      this.pubs = new Map(); // source -> TrackPublication
      this.isSpeaking = false;
    }
    getTrackPublication(source) {
      return this.pubs.get(source) || null;
    }
    get isMicrophoneEnabled() {
      const p = this.pubs.get(TrackSource.Microphone);
      return !!(p && !p.isMuted && p.track);
    }
    get isCameraEnabled() {
      const p = this.pubs.get(TrackSource.Camera);
      return !!(p && !p.isMuted && p.track);
    }
    get isScreenShareEnabled() {
      const p = this.pubs.get(TrackSource.ScreenShare);
      return !!(p && !p.isMuted && p.track);
    }
  }

  class LocalParticipant extends Participant {
    constructor(room) {
      super('', '', true, room);
      this._micCleanup = null;
      this._camCleanup = null;
      this._scrCleanup = null;
      this._ashCleanup = null;
    }

    async publishData(uint8Payload) {
      if (!this._room || !this._room._ws || this._room._ws.readyState !== WebSocket.OPEN) return;
      const txt = new TextDecoder().decode(uint8Payload);
      this._room._ws.send(txt);
    }

    async publishTrack(mediaStreamTrack, opts = {}) {
      const source = opts.source || TrackSource.Microphone;
      const name = opts.name || source;

      if (source === TrackSource.Microphone) {
        if (this._micCleanup) this._micCleanup();
        const track = new MediaTrack('audio', source, mediaStreamTrack);
        const pub = new TrackPublication(source, track, 'TR_MIC_' + this.identity, name);
        pub._onMuteChange = (muted) => {
          this._room._enviarEstadoMedia();
          this._room.emit(muted ? RoomEvent.TrackMuted : RoomEvent.TrackUnmuted, pub, this);
        };
        this.pubs.set(source, pub);
        this._iniciarEnvioVoz(mediaStreamTrack, pub, opts);
        this._room._enviarEstadoMedia();
        this._room.emit(RoomEvent.LocalTrackPublished, pub, this);
        return pub;
      }

      if (source === TrackSource.ScreenShareAudio) {
        if (this._ashCleanup) this._ashCleanup();
        const track = new MediaTrack('audio', source, mediaStreamTrack);
        const pub = new TrackPublication(source, track, 'TR_ASH_' + this.identity, name);
        this.pubs.set(source, pub);
        this._iniciarEnvioAudioCompartido(mediaStreamTrack, pub, name);
        this._room.emit(RoomEvent.LocalTrackPublished, pub, this);
        return pub;
      }

      const track = new MediaTrack('video', source, mediaStreamTrack);
      const pub = new TrackPublication(source, track, 'TR_VID_' + this.identity, name);
      this.pubs.set(source, pub);
      this._room._enviarEstadoMedia();
      this._room.emit(RoomEvent.LocalTrackPublished, pub, this);
      return pub;
    }

    async unpublishTrack(track) {
      for (const [src, pub] of this.pubs.entries()) {
        if (pub.track === track || !track) {
          this.pubs.delete(src);
          if (src === TrackSource.Microphone && this._micCleanup) {
            this._micCleanup();
            this._micCleanup = null;
          }
          if (src === TrackSource.ScreenShareAudio && this._ashCleanup) {
            this._ashCleanup();
            this._ashCleanup = null;
          }
          this._room._enviarEstadoMedia();
          this._room.emit(RoomEvent.LocalTrackUnpublished, pub, this);
        }
      }
    }

    // Permite cambiar en caliente el bitrate/perfil de voz (10 kbps <-> 18 kbps <-> 28 kbps)
    // según la velocidad de conexión detectada SIN cerrar el micrófono ni cortar la voz.
    actualizarPresetAudio(opts) {
      if (typeof this._actualizarBitrateMic === 'function') {
        this._actualizarBitrateMic(opts);
        return true;
      }
      return false;
    }

    _iniciarEnvioVoz(mediaStreamTrack, pub, opts) {
      let maxBr = (opts && opts.audioPreset && opts.audioPreset.maxBitrate) || 18000;
      let pendingBr = null;
      let actx = null;
      let esCtxCompartido = false;
      let proc = null;
      let srcNode = null;
      let muteGain = null;
      let opusEncoder = null;
      let opusListo = false;
      let opusTimestampUs = 0;
      // Pareo Opus POR ORDEN DE SALIDA: el encoder entrega sus chunks en el
      // mismo orden en que entraron las AudioData (FIFO garantizado), así
      // que cada dos salidas son las dos mitades de una trama de 40 ms y el
      // tx se toma de la cola de entrada. El timestamp del chunk NO es
      // fiable para emparejar: algunos navegadores lo devuelven desplazado
      // por el lookahead interno del codec — cada mitad caía en una
      // etiqueta distinta, jamás se emparejaban (el timeout de 90 ms las
      // liberaba como medias tramas: la "basurita" grabada; al quitarlo,
      // todo se quedaba esperando hasta el EOS).
      const opusTxCola = []; // txSeq de cada trama de 40 ms entregada al encoder
      const opusPend = [];   // chunks de salida esperando su gemelo (FIFO)
      const emitirOpusPkt = (tag, partes) => {
        if (!this._room || !partes || !partes.length) return;
        const s = tag & 0xffff;
        const rateCode = maxBr <= 11000 ? 10 : (maxBr <= 20000 ? 11 : 12);
        const b1 = partes[0];
        const b2 = partes.length > 1 ? partes[1] : null;
        const pkt = new Uint8Array(7 + b1.length + (b2 ? 2 + b2.length : 0));
        pkt[0] = FRAME_AUDIO;
        pkt[1] = rateCode;
        pkt[2] = s & 0xff;
        pkt[3] = (s >> 8) & 0xff;
        pkt[4] = 0xA5; // marca de paquete Opus (1 o 2 sub-tramas de 20 ms)
        pkt[5] = b1.length & 0xff;
        pkt[6] = (b1.length >> 8) & 0xff;
        pkt.set(b1, 7);
        if (b2) {
          const o = 7 + b1.length;
          pkt[o] = b2.length & 0xff;
          pkt[o + 1] = (b2.length >> 8) & 0xff;
          pkt.set(b2, o + 2);
        }
        // Sube por HTTP en trozos (~1 s): cada POST es una conexión
        // independiente — la fiabilidad la da el reintento del trozo y la
        // re-petición 'falta' del servidor, no la redundancia en el mismo
        // stream (que era lo que ahogaba la subida móvil).
        this._room._subirAudioPkt(pkt);
      };
      const drenarOpus = (completo) => {
        while (opusPend.length >= 2 || (completo && opusPend.length)) {
          const a = opusPend.shift();
          const b = opusPend.length ? opusPend.shift() : null;
          const tx = opusTxCola.length
            ? opusTxCola.shift()
            : (Math.floor(((a && a.timestamp) || 0) / 40000) & 0xffff);
          emitirOpusPkt(tx, b ? [a.bytes, b.bytes] : [a.bytes]);
        }
      };
      const emitirOpusParesRestantes = () => drenarOpus(true);
      // Cada audio nuevo cambia su identificador aid (1..15) y vuelve a
      // empezar su índice de trama en 0 (0, 1, 2...): así al soltar el PTT
      // y volver a pisar, el servidor termina de recibir las tramas que
      // faltaban del audio anterior (aid=1) mientras recibe el nuevo (aid=2, idx=0).
      let aid = 0;
      let txIdx = -1;
      let txSeq = 0;
      let enFrase = false;
      const abrirNuevoAudio = () => {
        if (!this._room) return;
        // Si tomarPiso() ya reservó un aid nuevo para esta pulsación de PTT,
        // usarlo para que piso_tomar, las tramas de audio y piso_soltar
        // compartan exactamente el mismo aid (p.ej. 1 para el primer PTT y 2
        // para el segundo). Si aún no había o ya se usó, avanzar al siguiente.
        if (this._room._pisoAidPend && this._room._pisoAidPend !== aid) {
          aid = this._room._pisoAidPend;
          this._room._pisoAidPend = 0;
        } else {
          this._room._vozAid = (((this._room._vozAid || 0) % 15) + 1);
          aid = this._room._vozAid;
          this._room._pisoAidAct = aid;
        }
        txIdx = -1;
        enFrase = true;
        // Mi nota "grabando" sale al instante sin esperar el eco del
        // servidor: si ese seg_ini se perdiera en la red, el provisional
        // adopta el seq real cuando llegue el eco o el seg_fin
        if (this._room) this._room.emit('voz_propia_ini', { inicio: Date.now() });
      };
      let hablandoActivo = false;

      // Estado ADPCM y filtro anti-aliasing para respaldo universal
      const adpcmState = { pred: 0, idx: 0 };
      let filtroAA = crearFiltroPasaBajos(48000, 5200);

      // Configurar codificador Opus nativo (tramas estándar de 20 ms = 960 muestras @ 48 kHz)
      const configurarOpus = (nuevoBr) => {
        maxBr = nuevoBr || 18000;
        pendingBr = null;
        const cutoff = maxBr <= 11000 ? 3500 : (maxBr <= 20000 ? 5200 : 6800);
        filtroAA = crearFiltroPasaBajos(48000, cutoff);
        if (!SOPORTE_OPUS_TX || typeof window.AudioEncoder !== 'function') return;
        try {
          if (!opusEncoder || opusEncoder.state === 'closed') {
            opusEncoder = new window.AudioEncoder({
              output: (chunk) => {
                if (!this._room) return;
                const n = chunk.byteLength;
                if (n <= 0) return;
                const bytes = new Uint8Array(n);
                chunk.copyTo(bytes);
                opusListo = true;
                opusPend.push({ bytes, timestamp: chunk.timestamp });
                // Cada dos salidas = una trama de 40 ms completa
                drenarOpus(false);
              },
              error: () => {
                opusListo = false;
                emitirOpusParesRestantes();
              },
            });
          }
          const opusBitrate = maxBr <= 11000 ? 10000 : (maxBr <= 20000 ? 18000 : 28000);
          try {
            opusEncoder.configure({
              codec: 'opus',
              sampleRate: 48000,
              numberOfChannels: 1,
              bitrate: opusBitrate,
              opus: {
                application: 'voip',
                frameDuration: 20000,
                complexity: 5,
              },
            });
            opusListo = true;
          } catch {
            opusEncoder.configure({
              codec: 'opus',
              sampleRate: 48000,
              numberOfChannels: 1,
              bitrate: opusBitrate,
            });
            opusListo = true;
          }
        } catch {
          opusListo = false;
        }
      };

      configurarOpus(maxBr);
      // Nunca reconfigurar Opus en mitad de una palabra: esperar a pausa de silencio
      this._actualizarBitrateMic = (nuevosOpts) => {
        const br = (nuevosOpts && nuevosOpts.audioPreset && nuevosOpts.audioPreset.maxBitrate) || 18000;
        if (br === maxBr) return;
        if (hablandoActivo) {
          pendingBr = br;
        } else {
          configurarOpus(br);
        }
      };

      // Enviar marcador explícito de fin de frase (EOS) con el mismo (aid, idx)
      // de la última trama enviada de este audio, y cerrar enFrase para que
      // la próxima vez que hable cambie a un nuevo aid con trama 0.
      const enviarMarcadorEOS = () => {
        if (!this._room || !enFrase) return;
        enFrase = false;
        // Vacía las medias-tramas que quedaron esperando su gemelo: salen
        // como paquete de 20 ms ANTES del EOS, en el mismo trozo — el
        // servidor las archiva en su hueco y nada queda pendiente
        emitirOpusParesRestantes();
        const s = txSeq & 0xffff;
        const eos = new Uint8Array([FRAME_AUDIO, 0, s & 0xff, (s >> 8) & 0xff]);
        // El EOS cierra el trozo en armado y sale en su propio POST al
        // instante — el servidor cierra la frase sin esperar más tramas
        this._room._subirAudioPkt(eos);
        this._room._flushChunk();
      };

      // Enviar un bloque de 40 ms (1920 muestras @ 48 kHz). Si empieza un
      // audio nuevo, asigna nuevo aid (001 -> 002) y empieza en trama 0.
      const enviarTrama40ms = (frame48k) => {
        if (!this._room) return;
        if (!enFrase || txIdx >= 4090) abrirNuevoAudio();
        txIdx = (txIdx + 1) & 0x0fff;
        txSeq = ((aid & 0x0f) << 12) | txIdx;

        let enviadoOpus = false;
        if (opusEncoder && opusEncoder.state === 'configured' && opusListo) {
          try {
            for (let half = 0; half < 2; half++) {
              const sub20ms = frame48k.subarray(half * 960, (half + 1) * 960);
              const ad = new window.AudioData({
                format: 'f32-planar',
                sampleRate: 48000,
                numberOfFrames: 960,
                numberOfChannels: 1,
                // la etiqueta del audio viaja en el timestamp: sale intacta
                // en chunk.timestamp al otro lado del encoder
                timestamp: txSeq * 40000 + half * 20000,
                data: sub20ms,
              });
              opusEncoder.encode(ad);
              ad.close();
            }
            enviadoOpus = true;
            // el tx viaja en la cola de entrada: las dos salidas del
            // encoder se emparejan por orden, sin depender del timestamp
            opusTxCola.push(txSeq);
            if (opusTxCola.length > 256) opusTxCola.shift(); // cota anti-deriva
          } catch {
            enviadoOpus = false;
          }
        }

        // Si el navegador no tiene Opus o en la sala hay algún oyente sin Opus,
        // enviamos la trama ADPCM limpia a 8/12/16 kHz con número de secuencia
        const necesitaAdpcm = !enviadoOpus || !!this._room._haySinOpus;
        if (necesitaAdpcm) {
          // Factor exacto desde 48000 Hz: 6 -> 8000 Hz (32 kbps), 4 -> 12000 Hz (48 kbps), 3 -> 16000 Hz (64 kbps)
          const decim = maxBr <= 11000 ? 6 : (maxBr <= 20000 ? 4 : 3);
          const baseCode = maxBr <= 11000 ? 21 : (maxBr <= 20000 ? 22 : 23);
          const rateCode = enviadoOpus ? (baseCode + 10) : baseCode;
          const outLen = (1920 / decim) | 0;
          const sub = new Float32Array(outLen);
          for (let i = 0; i < outLen; i++) {
            let acc = 0;
            const base = i * decim;
            for (let k = 0; k < decim; k++) {
              acc += filtroAA(frame48k[base + k]);
            }
            sub[i] = acc / decim;
          }
          const pkt = codificarBloqueADPCM(sub, adpcmState, rateCode, txSeq);
          this._room._subirAudioPkt(pkt);
        }
      };

      try {
        // Reutilizar el AudioContext y nodo de ganancia de construirMicTrack() en app.js
        // para eliminar el doble AudioContext (MediaStreamDestination -> MediaStreamSource)
        if (mediaStreamTrack && mediaStreamTrack._sharedCtx && mediaStreamTrack._sharedNode && mediaStreamTrack._sharedCtx.state !== 'closed') {
          actx = mediaStreamTrack._sharedCtx;
          srcNode = mediaStreamTrack._sharedNode;
          esCtxCompartido = true;
        } else {
          actx = new (window.AudioContext || window.webkitAudioContext)();
          const rawStream = (mediaStreamTrack && mediaStreamTrack._rawStream) || new MediaStream([mediaStreamTrack]);
          srcNode = actx.createMediaStreamSource(rawStream);
          esCtxCompartido = false;
        }
        if (actx.state === 'suspended') {
          actx.resume().catch(() => {});
        }

        proc = null;
        let txWorklet = null;
        muteGain = actx.createGain();
        muteGain.gain.value = 0; // silencio total hacia destination local; mantiene vivo el reloj de hardware
        const inRate = actx.sampleRate || 48000;
        const stepIn = inRate / 48000;
        const filtroHP = crearFiltroPasaAltos85Hz(inRate);

        // Acumulador de 40 ms exactos (1920 muestras @ 48 kHz) con interpolación lineal continua
        const frameBuf = new Float32Array(1920);
        let frameFill = 0;
        let inPhase = 0;
        let lastInSample = 0;

        // VAD con pre-roll de 40 ms y cola larga de 800 ms (20 bloques de 40 ms):
        // jamás corta dentro de una palabra ni en las pausas naturales de una frase.
        let prevFrame48k = new Float32Array(1920);
        let tienePrevFrame = false;
        let silencioCola = 0;
        let noiseFloor = 0.0018;
        let rmsMedia = 0, rmsDev = 0, planoN = 0; // detector de ruido sostenido
        let ultimoPedirPiso = 0;
        let autoPre = null; // pre-roll guardado esperando el piso
        const tramaMuda = new Float32Array(1920); // colchón de silencio al abrir frase
        let autoPreTs = 0;
        let vozSeg = 0; // tramas seguidas sobre el umbral (debounce de ataque)

        const procesarBloqueEntrada = (rawIn) => {
          // Muteado o sin room: cierra la frase. Sin socket NO se cierra: las
          // tramas se encolan y el servidor las archiva cuando la red vuelva.
          if (pub.isMuted || !this._room) {
            if (hablandoActivo) {
              hablandoActivo = false;
              silencioCola = 0;
              enviarMarcadorEOS();
              if (this._room) {
                this._room._marcarHablandoLocal(false);
                if (window.S && S.ptt && S.ptt.modo === 'auto') this._room.soltarPiso();
              }
            }
            return;
          }
          const nIn = rawIn.length;
          if (nIn === 0) return;

          const filtered = new Float32Array(nIn);
          for (let i = 0; i < nIn; i++) {
            filtered[i] = filtroHP(rawIn[i]);
          }

          while (inPhase < nIn) {
            const idx = inPhase | 0;
            const frac = inPhase - idx;
            const s0 = idx === 0 ? lastInSample : filtered[idx - 1];
            const s1 = filtered[idx];
            frameBuf[frameFill++] = s0 + frac * (s1 - s0);
            inPhase += stepIn;

            if (frameFill === 1920) {
              frameFill = 0;
              let sum = 0;
              for (let j = 0; j < 1920; j += 2) {
                const v = frameBuf[j];
                sum += v * v;
              }
              const rms = Math.sqrt(sum / 960);

              const sens = (window.S && S.ptt && S.ptt.sens) || 2.0;
              const umbralAbrir = Math.max(0.0032, noiseFloor * sens);
              // ataque: N tramas seguidas de voz antes de activar (evita que
              // un golpe o ruido ambiente aislado "pise el botón" en auto)
              const ataqueN = Math.max(1, Math.round(((window.S && S.ptt && S.ptt.ataque) || 0.12) / 0.04));
              if (rms >= umbralAbrir) vozSeg++; else vozSeg = 0;
              const vozOk = rms >= umbralAbrir && (hablandoActivo || vozSeg >= ataqueN);
              // El piso de ruido se re-ajusta también con la frase abierta
              // (en tramas sin voz clara): si el ambiente sube mientras se
              // habla, el umbral lo sigue y el automático no queda pegado
              // eternamente por ruido de fondo
              if (rms < noiseFloor * 1.5 || (hablandoActivo && rms < umbralAbrir)) {
                noiseFloor = Math.max(0.0008, Math.min(0.01, noiseFloor * 0.96 + rms * 0.04));
              }
              // Ruido sostenido: con la frase abierta, un nivel ALTO y PLANO
              // (poca variación = ventilador/eco/calle, no habla que es a
              // ráfagas) sube el piso hasta ese nivel — el ruido constante
              // que superaba el umbral deja de contar como voz y la frase
              // cierra tras el silencio configurado
              if (hablandoActivo) {
                planoN++;
                rmsMedia = rmsMedia ? rmsMedia * 0.94 + rms * 0.06 : rms;
                rmsDev = rmsDev ? rmsDev * 0.94 + Math.abs(rms - rmsMedia) * 0.06 : 0;
                if (planoN > 25 && rmsMedia > noiseFloor * 1.1 && rmsDev < rmsMedia * 0.3) {
                  noiseFloor = Math.min(0.02, noiseFloor * 0.95 + rmsMedia * 0.05);
                }
              } else { planoN = 0; rmsMedia = 0; rmsDev = 0; }

              // En modo PTT el botón manda, no el VAD: mientras se tenga el
              // piso se transmite TODO (una pulsación = una nota de voz
              // completa, sin cortes por pausas) y el segmento solo se
              // cierra al soltar el botón. Si aún no se concede el piso no
              // se gasta subida (las tramas las descartaría el servidor).
              const ptt = window.S && window.S.ptt && window.S.ptt.modo !== 'auto';
              if (ptt) {
                if (window.S.ptt.quiero && window.S.ptt.tengo) {
                  if (!hablandoActivo) {
                    hablandoActivo = true;
                    // ~80 ms de audio vacío al abrir la frase: da margen a
                    // que el receptor cree el segmento y no se coma el
                    // ataque de la primera sílaba
                    enviarTrama40ms(tramaMuda);
                    enviarTrama40ms(tramaMuda);
                  }
                  silencioCola = 0;
                  this._room._marcarHablandoLocal(true);
                  enviarTrama40ms(frameBuf);
                } else if (hablandoActivo) {
                  hablandoActivo = false;
                  silencioCola = 0;
                  enviarMarcadorEOS();
                  this._room._marcarHablandoLocal(false);
                }
              } else {
                // Modo automático: la voz pisa el botón. El micro escucha en
                // local SIEMPRE, pero al servidor solo se transmite cuando el
                // piso ya es mío (S.ptt.tengo): sin piso no se gasta subida.
                const quieroPtt = window.S && S.ptt && S.ptt.quiero;
                // Cola de silencio ("Soltar tras N s", tope 5 s): SOLO la
                // voz clara (≥ umbral de apertura) la recarga. El ruido de
                // fondo o la voz demasiado baja cuentan como silencio — así
                // el cierre tarda lo configurado y no lo que dure el ruido
                const silSeg = Math.min(5, (window.S && S.ptt && S.ptt.silencio) || 2.2);
                const colaMax = Math.max(8, Math.round(silSeg / 0.04));
                if (rms >= umbralAbrir) silencioCola = colaMax;
                else if (silencioCola > 0) silencioCola--;
                if ((vozOk || hablandoActivo || quieroPtt) &&
                    (rms >= umbralAbrir || silencioCola > 0 || quieroPtt)) {
                  if (!hablandoActivo) {
                    hablandoActivo = true;
                    ultimoPedirPiso = performance.now();
                    autoPreTs = ultimoPedirPiso;
                    if (this._room) this._room.tomarPiso();
                    // pre-roll de 40 ms guardado: se suelta apenas concedan
                    // el piso para conservar el ataque de la primera sílaba
                    autoPre = tienePrevFrame ? new Float32Array(prevFrame48k) : null;
                  }
                  this._room._marcarHablandoLocal(true);
                  const tengo = window.S && S.ptt && S.ptt.tengo;
                  if (tengo) {
                    if (autoPre) {
                      // el pre-roll solo sirve si el piso llegó al instante;
                      // tras una espera larga es un blip desconectado
                      if (performance.now() - autoPreTs < 1500) {
                        for (let k = 0; k < 192; k++) autoPre[k] *= (k / 192);
                        enviarTrama40ms(autoPre);
                      }
                      autoPre = null;
                    }
                    enviarTrama40ms(frameBuf);
                  } else if (this._room && performance.now() - ultimoPedirPiso > 900) {
                    // piso ajeno: reintenta por si el otro ya soltó
                    ultimoPedirPiso = performance.now();
                    this._room.tomarPiso();
                  }
                } else if (hablandoActivo) {
                  // silencio agotó la cola: fundido de salida + cierre
                  const tail = new Float32Array(frameBuf);
                  for (let k = 0; k < 1920; k++) tail[k] *= (1 - k / 1920);
                  enviarTrama40ms(tail);
                  enviarMarcadorEOS();
                  hablandoActivo = false;
                  this._room._marcarHablandoLocal(false);
                  // modo auto: soltar el piso cierra la frase y deja hablar a otro
                  this._room.soltarPiso();
                  if (pendingBr !== null && pendingBr !== maxBr) {
                    configurarOpus(pendingBr);
                  }
                } else {
                  if (pendingBr !== null && pendingBr !== maxBr) {
                    configurarOpus(pendingBr);
                  }
                }
              }

              prevFrame48k.set(frameBuf);
              tienePrevFrame = true;
            }
          }
          inPhase -= nIn;
          lastInSample = filtered[nIn - 1];
        };

        let micCerrado = false;
        asegurarWorkletEnCtx(actx).then((ok) => {
          if (micCerrado) return;
          if (ok && typeof window.AudioWorkletNode === 'function') {
            try {
              txWorklet = new window.AudioWorkletNode(actx, 'conferencia-tx-worklet', {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [1],
              });
              txWorklet.port.onmessage = (ev) => {
                if (ev.data instanceof Float32Array) {
                  procesarBloqueEntrada(ev.data);
                }
              };
              srcNode.connect(txWorklet);
              txWorklet.connect(muteGain);
              muteGain.connect(actx.destination);
              return;
            } catch {}
          }
          // Fallback si el navegador no soporta AudioWorklet
          proc = actx.createScriptProcessor(2048, 1, 1);
          proc.onaudioprocess = (ev) => {
            ev.outputBuffer.getChannelData(0).fill(0);
            procesarBloqueEntrada(ev.inputBuffer.getChannelData(0));
          };
          srcNode.connect(proc);
          proc.connect(muteGain);
          muteGain.connect(actx.destination);
        });

        this._micCleanup = () => {
          micCerrado = true;
          this._actualizarBitrateMic = null;
          // Al soltar el PTT manual: vaciar el encoder (emitir las sub-tramas
          // que quedaran sueltas) y LUEGO enviar el EOS con (aid, ultimoIdx)
          // para que el servidor sepa cuál fue la última trama de este audio.
          const cerrarFrase = () => {
            emitirOpusParesRestantes();
            if (enFrase) enviarMarcadorEOS();
          };
          try {
            if (opusEncoder && opusEncoder.state === 'configured') {
              opusEncoder.flush().then(cerrarFrase, cerrarFrase);
            } else cerrarFrase();
          } catch { cerrarFrase(); }
          try { if (opusEncoder && opusEncoder.state !== 'closed') opusEncoder.close(); } catch {}
          opusEncoder = null;
          try { if (txWorklet) txWorklet.disconnect(); } catch {}
          try { if (proc) proc.disconnect(); } catch {}
          try { if (muteGain) muteGain.disconnect(); } catch {}
          if (!esCtxCompartido) {
            try { if (srcNode) srcNode.disconnect(); } catch {}
            try { if (actx) actx.close(); } catch {}
          }
          this._room._marcarHablandoLocal(false);
        };
      } catch (e) {
        console.warn('Error iniciando codificador de voz:', e);
      }
    }

    _iniciarEnvioAudioCompartido(mediaStreamTrack, pub, name) {
      let actx = null;
      let proc = null;
      let srcNode = null;
      let muteGain = null;
      let shareSeq = 0;
      const adpcmState = { pred: 0, idx: 0 };
      const filtroAA = crearFiltroPasaBajos(48000, 6500);
      try {
        this._room._ws.send(JSON.stringify({ t: 'audio_share_meta', activo: true, nombre: name }));
        actx = new (window.AudioContext || window.webkitAudioContext)();
        const ms = new MediaStream([mediaStreamTrack]);
        srcNode = actx.createMediaStreamSource(ms);
        proc = actx.createScriptProcessor(4096, 1, 1);
        muteGain = actx.createGain();
        muteGain.gain.value = 0;
        const inRate = actx.sampleRate || 48000;
        const targetRate = 16000;
        const ratio = inRate / targetRate;

        proc.onaudioprocess = (ev) => {
          ev.outputBuffer.getChannelData(0).fill(0);
          if (pub.isMuted || !this._room || !this._room._ws || this._room._ws.readyState !== WebSocket.OPEN) return;
          if (this._room._ws.bufferedAmount > 192 * 1024) return;
          const input = ev.inputBuffer.getChannelData(0);
          let sum = 0;
          for (let i = 0; i < input.length; i += 4) sum += input[i] * input[i];
          if (Math.sqrt(sum / (input.length / 4)) < 0.0015) return;

          const outLen = Math.floor(input.length / ratio);
          const sub = new Float32Array(outLen);
          for (let i = 0; i < outLen; i++) {
            const idx = Math.min(input.length - 1, Math.floor(i * ratio));
            sub[i] = filtroAA(input[idx]);
          }
          shareSeq = (shareSeq + 1) & 0xffff;
          const pkt = codificarBloqueADPCM(sub, adpcmState, 23, shareSeq);
          pkt[0] = FRAME_AUDIO_SHARE;
          try { this._room._ws.send(pkt); } catch {}
        };
        srcNode.connect(proc);
        proc.connect(muteGain);
        muteGain.connect(actx.destination);
      } catch (e) {
        console.warn('Error compartiendo audio:', e);
      }
      this._ashCleanup = () => {
        try {
          if (this._room && this._room._ws && this._room._ws.readyState === WebSocket.OPEN) {
            this._room._ws.send(JSON.stringify({ t: 'audio_share_meta', activo: false }));
          }
        } catch {}
        try { if (proc) proc.disconnect(); } catch {}
        try { if (muteGain) muteGain.disconnect(); } catch {}
        try { if (srcNode) srcNode.disconnect(); } catch {}
        try { if (actx) actx.close(); } catch {}
      };
    }

    async setCameraEnabled(enabled, constraints = {}) {
      if (!enabled) {
        if (this._camCleanup) {
          this._camCleanup();
          this._camCleanup = null;
        }
        const pub = this.pubs.get(TrackSource.Camera);
        if (pub) {
          this.pubs.delete(TrackSource.Camera);
          if (pub.track) pub.track.stop();
          this._room._enviarEstadoMedia();
          this._room.emit(RoomEvent.LocalTrackUnpublished, pub, this);
        }
        return;
      }

      if (!this._room._canCam) {
        throw new Error('La cámara solo está permitida en el Asiento 1 (Anfitrión) o con La Palabra');
      }

      const iniciarCaptura = async (cons) => {
        const videoCons = {
          width: { ideal: 320, max: 360 },
          height: { ideal: 240, max: 270 },
          frameRate: { ideal: 10, max: 12 },
          ...(cons || {}),
        };
        return await navigator.mediaDevices.getUserMedia({ video: videoCons, audio: false });
      };

      let stream;
      try {
        stream = await iniciarCaptura(constraints);
      } catch (e) {
        if (constraints && constraints.deviceId && e && e.name === 'OverconstrainedError') {
          stream = await iniciarCaptura({ deviceId: { ideal: constraints.deviceId.exact || constraints.deviceId } });
        } else {
          throw e;
        }
      }

      if (this._camCleanup) {
        this._camCleanup();
        this._camCleanup = null;
      }

      const vtrack = stream.getVideoTracks()[0];
      const track = new MediaTrack('video', TrackSource.Camera, vtrack);
      const pub = new TrackPublication(TrackSource.Camera, track, 'TR_CAM_' + this.identity, 'camera');

      // Soporte para cambiarCamara() en caliente con restartTrack()
      track._onRestart = async (newCons) => {
        const nuevoStream = await iniciarCaptura(newCons);
        const nuevoVt = nuevoStream.getVideoTracks()[0];
        if (track.mediaStreamTrack) {
          try { track.mediaStreamTrack.stop(); } catch {}
        }
        track.mediaStreamTrack = nuevoVt;
        for (const el of track._els) {
          el.srcObject = new MediaStream([nuevoVt]);
          el.play().catch(() => {});
        }
        if (videoHidden) {
          videoHidden.srcObject = new MediaStream([nuevoVt]);
          videoHidden.play().catch(() => {});
        }
      };

      this.pubs.set(TrackSource.Camera, pub);

      // Bucle de compresión 240p por WebSocket HTTPS/443 (10 fps, ~40-80 kbps)
      const videoHidden = document.createElement('video');
      videoHidden.muted = true;
      videoHidden.playsInline = true;
      videoHidden.autoplay = true;
      videoHidden.srcObject = stream;
      videoHidden.play().catch(() => {});

      const cv = document.createElement('canvas');
      cv.width = 320;
      cv.height = 240;
      const cx = cv.getContext('2d');
      let enviando = false;

      const timer = setInterval(() => {
        if (enviando || pub.isMuted || !this._room || !this._room._ws || this._room._ws.readyState !== WebSocket.OPEN) return;
        // Control de congestión para 3G/2G: si la cola del socket tiene >24 KB, saltar este frame
        if (this._room._ws.bufferedAmount > 24 * 1024) return;
        if (videoHidden.videoWidth <= 0) return;
        enviando = true;
        cx.drawImage(videoHidden, 0, 0, cv.width, cv.height);
        cv.toBlob((blob) => {
          if (!blob || !this._room || !this._room._ws || this._room._ws.readyState !== WebSocket.OPEN) {
            enviando = false;
            return;
          }
          blob.arrayBuffer().then((ab) => {
            const u8 = new Uint8Array(ab);
            const pkt = new Uint8Array(1 + u8.length);
            pkt[0] = FRAME_VIDEO;
            pkt.set(u8, 1);
            try { this._room._ws.send(pkt); } catch {}
            enviando = false;
          }).catch(() => { enviando = false; });
        }, 'image/webp', 0.48);
      }, 100); // 10 fps

      this._camCleanup = () => {
        clearInterval(timer);
        try { vtrack.stop(); } catch {}
        try { videoHidden.srcObject = null; } catch {}
      };

      this._room._enviarEstadoMedia();
      this._room.emit(RoomEvent.LocalTrackPublished, pub, this);
      return pub;
    }

    async setScreenShareEnabled(enabled) {
      if (!enabled) {
        if (this._scrCleanup) {
          this._scrCleanup();
          this._scrCleanup = null;
        }
        const pub = this.pubs.get(TrackSource.ScreenShare);
        if (pub) {
          this.pubs.delete(TrackSource.ScreenShare);
          if (pub.track) pub.track.stop();
          this._room._enviarEstadoMedia();
          this._room.emit(RoomEvent.LocalTrackUnpublished, pub, this);
        }
        return;
      }

      if (!this._room._canPan) {
        throw new Error('Compartir pantalla solo está permitido en el Asiento 1 o con La Palabra');
      }

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { max: 960 }, height: { max: 540 }, frameRate: { max: 5 } },
        audio: false,
      });
      const vtrack = stream.getVideoTracks()[0];
      vtrack.onended = () => { this.setScreenShareEnabled(false); };

      const track = new MediaTrack('video', TrackSource.ScreenShare, vtrack);
      const pub = new TrackPublication(TrackSource.ScreenShare, track, 'TR_SCR_' + this.identity, 'screen');
      this.pubs.set(TrackSource.ScreenShare, pub);

      const videoHidden = document.createElement('video');
      videoHidden.muted = true;
      videoHidden.playsInline = true;
      videoHidden.autoplay = true;
      videoHidden.srcObject = stream;
      videoHidden.play().catch(() => {});

      const cv = document.createElement('canvas');
      cv.width = 854;
      cv.height = 480;
      const cx = cv.getContext('2d');
      let enviando = false;

      const timer = setInterval(() => {
        if (enviando || pub.isMuted || !this._room || !this._room._ws || this._room._ws.readyState !== WebSocket.OPEN) return;
        if (this._room._ws.bufferedAmount > 32 * 1024) return;
        if (videoHidden.videoWidth <= 0) return;
        enviando = true;
        cx.drawImage(videoHidden, 0, 0, cv.width, cv.height);
        cv.toBlob((blob) => {
          if (!blob || !this._room || !this._room._ws || this._room._ws.readyState !== WebSocket.OPEN) {
            enviando = false;
            return;
          }
          blob.arrayBuffer().then((ab) => {
            const u8 = new Uint8Array(ab);
            const pkt = new Uint8Array(1 + u8.length);
            pkt[0] = FRAME_SCREEN;
            pkt.set(u8, 1);
            try { this._room._ws.send(pkt); } catch {}
            enviando = false;
          }).catch(() => { enviando = false; });
        }, 'image/webp', 0.55);
      }, 250); // 4 fps para pantalla legible y ligera

      this._scrCleanup = () => {
        clearInterval(timer);
        try { vtrack.stop(); } catch {}
        try { videoHidden.srcObject = null; } catch {}
      };

      this._room._enviarEstadoMedia();
      this._room.emit(RoomEvent.LocalTrackPublished, pub, this);
      return pub;
    }
  }

  class Room extends Emitter {
    constructor() {
      super();
      this.localParticipant = new LocalParticipant(this);
      this.remoteParticipants = new Map();
      this.disconnectReason = undefined;
      this._ws = null;
      this._canMic = false;
      this._canCam = false;
      this._canPan = false;
      this._haySinOpus = false;
      this._rxAudioCtx = null;
      this._rxPipelines = new Map(); // sid -> pipeline continuo con ring buffer
      this._speakers = new Map();    // identity -> expireTs
      this._pisoDe = '';             // quién tiene el piso (piso_estado)
      this._speakerTimer = null;
      this._pingTimer = null;
      this._rttMs = 90;
      this._jitterMs = 15;
      this._calidadActual = ConnectionQuality.Good;
      this._buenasSeguidas = 0;
      // Cola TX confiable: con un micro-corte la voz del emisor se encola y
      // sale en ráfaga cuando el socket vuelve — nunca se descarta
      this._txCola = [];
      this._txBytes = 0;
      this._txFlushT = null;
      // Mensajes críticos (tomar/soltar el piso): cola propia con PRIORIDAD
      // — soltar no espera detrás de megabytes de voz acumulada en un corte
      this._ctrlCola = [];
      // Buffer de retransmisión de MI voz (anti-pérdida simétrico a la
      // descarga): el servidor pide por {t:'falta'} las tramas que no le
      // llegaron y yo las reenvío. Se conserva la frase actual y la
      // anterior (puedo soltar el PTT antes de que el servidor complete).
      this._vozTxPend = new Map();   // (tx<<1|fam) -> Uint8Array
      this._vozTxFases = [];         // [[clave,...], ...] últimas 2 frases
      this._vozTxFaseAct = null;     // claves de la frase abierta
      this._vozTxBytes = 0;
      // Subida de voz por HTTP en trozos independientes (~1 s): cada POST es
      // una conexión aparte — un trozo atascado se reintenta por otra
      // conexión y jamás frena a los demás (cero bloqueo head-of-line).
      this._chunkTx = [];            // payloads de trama del trozo en armado
      this._chunkFlushT = null;      // cierre de trozo por tiempo
      this._chunkPend = [];          // bodies binarios esperando POST
      this._chunkEnVuelo = 0;        // POSTs activos (máx. 4)
      this._chunkRetryT = null;
      // Piso exclusivo (PTT): el servidor garantiza un solo hablante
      this._quieroPiso = false;
      this._tengoPiso = false;
      this._pisoHoldT = null;
      // Cola ordenada de segmentos de voz ("notas de voz en vivo"): las
      // frases se reproducen en orden; las que faltan se descargan por HTTP
      this._vozSegs = new Map();        // seq -> segmento
      this._vozOrden = [];              // segmentos ordenados por seq
      this._segPorHablante = new Map(); // identidad -> seq del segmento abierto
      this._ultimoSeg = 0;
      this._vozBase = false;            // la 1ª bienvenida fija la base
      this._vozPipe = null;             // reproductor único ordenado
      this._vozBufMs = 0;               // ms de PCM ya empujados al reproductor
      // Colchón autorregulado a 1.0x: empieza en 1,2 s; si ocurre un bache
      // de N segundos, el colchón sube a N segundos (hasta 10 s) y como la
      // voz suena siempre a 1.0x sin acelerar, ese colchón absorbe todos los
      // baches siguientes durante el resto de la conversación.
      this._jitMs = 1200;
      this._jitBumpT = 0;
      this._jitUltimoCorte = 0;
      this._starveDesde = 0;
      this._vozRate = 48000;
      this._feedT = null;
      this._feedUltimo = 0;
      this._fetchSegs = new Set();      // seqs con descarga en curso
      this._vozOidos = new Set();       // seqs ya escuchadas o saltadas:
                                        // sobrevive reconexiones — una nota
                                        // oída JAMÁS se vuelve a reproducir
      this._txOidos = new Map();        // de -> Map(tx -> ts): pedazos ya
                                        // sonados POR HABLANTE — un audio
                                        // revivido con otro seq se descarta
      this._replayQ = [];               // notas re-escuchadas (prioridad)
      this._replayPendMs = 0;           // ms de nota ya en el reproductor sin sonar
      this._replayPlayedMs = 0;         // ms acumulados de nota ya escuchados
      this._replayProg = [];            // {seq, msTotal, finMs} para progreso/fin
      this._replayPausas = new Map();   // seq → {posMs, msTotal, bloques} pausadas
      this._progUltimo = 0;
      this._volPorId = new Map();       // identidad -> volumen directo
      this._retrasoAviso = 0;
      this._drenando = false;
      this._pseudoN = 0;
      this._vozHeadSeq = null;
      this._autoPresente = false;
    }

    _asegurarRxAudioCtx() {
      if (!this._rxAudioCtx || this._rxAudioCtx.state === 'closed') {
        if (window.S && window.S.salidaCtx && window.S.salidaCtx.state !== 'closed') {
          this._rxAudioCtx = window.S.salidaCtx;
        } else {
          this._rxAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
          if (window.S) window.S.salidaCtx = this._rxAudioCtx;
        }
        asegurarWorkletEnCtx(this._rxAudioCtx);
        if (!window._audioDesbloqueado) {
          window._audioDesbloqueado = true;
          const unlock = () => {
            if (window.S && window.S.salidaCtx && window.S.salidaCtx.state === 'suspended') {
              window.S.salidaCtx.resume().catch(() => {});
            }
          };
          window.addEventListener('pointerdown', unlock, { passive: true });
          window.addEventListener('touchstart', unlock, { passive: true });
          window.addEventListener('keydown', unlock, { passive: true });
        }
      }
      if (this._rxAudioCtx.state === 'suspended') {
        this._rxAudioCtx.resume().catch(() => {});
      }
      return this._rxAudioCtx;
    }

    _marcarHablandoLocal(hablando) {
      const id = this.localParticipant.identity;
      if (!id) return;
      if (hablando) {
        this._speakers.set(id, Date.now() + 600);
      } else {
        this._speakers.delete(id);
      }
      if (this._localHablando !== hablando) {
        this._localHablando = hablando;
        this._actualizarSpeakers();
      }
    }

    _actualizarSpeakers() {
      const now = Date.now();
      // Quien tiene el piso sigue "hablando" aunque sus tramas no lleguen
      // (lag o corte del emisor): el indicador solo se apaga cuando suelta
      // el PTT y además se drena su cola — no antes
      if (this._pisoDe && this._pisoDe !== this.localParticipant.identity) {
        this._speakers.set(this._pisoDe, now + 900);
      }
      // Mientras su frase suena de verdad también se sostiene la marca:
      // tras el piso_soltar dejan de llegar tramas pero la cola sigue
      // reproduciéndose — "dejó de hablar" = soltó Y terminó su audio
      const act = this._vozHeadSeq != null ? this._vozSegs.get(this._vozHeadSeq) : null;
      if (act && !act.propio && !act.saltado && !act.reproducido &&
          act.alimentado < act.bloques.length) {
        this._speakers.set(act.de, now + 900);
      }
      const activos = [];
      for (const [id, exp] of this._speakers.entries()) {
        if (exp > now) {
          const p = id === this.localParticipant.identity
            ? this.localParticipant
            : this.remoteParticipants.get(id);
          if (p) activos.push(p);
        } else {
          this._speakers.delete(id);
        }
      }
      const clave = activos.map(p => p.identity).join(',');
      if (clave === this._ultSpeakersClave) return;
      this._ultSpeakersClave = clave;
      this.emit(RoomEvent.ActiveSpeakersChanged, activos);
    }

    // ---------- envío confiable (voz del emisor) ----------
    // La voz nunca se descarta en el emisor: si el socket está caído o la
    // cola TCP creció, la trama espera en _txCola y sale en ráfaga al
    // reconectar. El servidor la archiva en el segmento igualmente.
    // Mensajes de control: los CRÍTICOS (tomar/soltar el piso = empezar o
    // dejar de grabar) no se pierden con un corte — se encolan junto a las
    // tramas y llegan al servidor cuando la red vuelva, como las notas del
    // historial. Los latidos no se encolan: el siguiente sale solo.
    _enviarJson(obj, critico) {
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        try { this._ws.send(JSON.stringify(obj)); return; } catch {}
      }
      if (critico) {
        const s = JSON.stringify(obj);
        if (this._ctrlCola.length < 200) {
          this._ctrlCola.push(s); // prioridad: sale antes que la voz encolada
          this._programarFlushTx();
        }
      }
    }

    _enviarFrame(pkt) {
      if (pkt && pkt[0] === 0x01 && pkt.length >= 4) this._registrarVozTx(pkt);
      // 48 KB ≈ 4-8 s de voz: TCP encola en ráfagas y vacía solo; con el
      // umbral viejo de 12 KB la subida móvil encolaba TODA la frase en
      // _txCola y los oyentes la oían recién al soltar el PTT.
      if (this._ws && this._ws.readyState === WebSocket.OPEN && this._ws.bufferedAmount < 48 * 1024) {
        try { this._ws.send(pkt); return; } catch {}
      }
      // ~16 MB ≈ 35-40 min de voz a 10 kbps: jamás descartar paquetes en
      // baches móviles largos (de minutos) — al volver la señal salen todos
      if (this._txBytes + pkt.length <= 16777216) {
        this._txCola.push(pkt);
        this._txBytes += pkt.length;
        this._purgarTxViejo();
        this._programarFlushTx();
      }
    }

    // Con la subida ahogada conviene soltar el audio MÁS VIEJO de la cola
    // (el servidor re-pide cada hueco por 'falta' y la pieza se reenvía
    // desde la semilla _vozTxPend) en vez de dejar crecer el retraso en
    // vivo hasta el final de la frase — preferimos ~4 s de atraso acotado
    // + huecos reparados que una ráfaga tardía. EOS y control jamás se
    // sueltan: cierran la frase y el piso.
    _purgarTxViejo() {
      while (this._txBytes > 49152) {
        let i = -1;
        for (let k = 0; k < this._txCola.length; k++) {
          const p = this._txCola[k];
          if (p && p[0] === 0x01 && p[1] !== 0) { i = k; break; }
        }
        if (i < 0) break;
        const p = this._txCola.splice(i, 1)[0];
        this._txBytes -= p.length;
      }
    }

    _programarFlushTx() {
      if (this._txFlushT) return;
      this._txFlushT = setTimeout(() => { this._txFlushT = null; this._drenarTx(); }, 120);
    }

    // ---------- retransmisión de MI voz (el servidor pide lo que perdió) ----------
    // Clave = (tx<<1)|familia: el mismo bloque de 40 ms puede ir en Opus y en
    // respaldo ADPCM — se guardan las dos variantes por si el servidor
    // recibió una y perdió la otra.
    _registrarVozTx(pkt) {
      const rc = pkt[1];
      const tx = pkt[2] | (pkt[3] << 8);
      const fam = (rc >= 10 && rc <= 19) ? 0 : 1;
      const clave = (tx << 1) | fam;
      if (this._vozTxPend.has(clave)) return; // reintento: ya registrada
      if (!this._vozTxFaseAct) {
        this._vozTxFaseAct = [];
        this._vozTxFases.push(this._vozTxFaseAct);
      }
      this._vozTxFaseAct.push(clave);
      this._vozTxPend.set(clave, pkt);
      this._vozTxBytes += pkt.length;
      if (rc === 0) {
        // EOS: también se guarda — al reenviar tras un corte "sella" el
        // final de la frase en el servidor. Cierra la fase local, PERO la
        // semilla NO se descarta: solo se suelta cuando el servidor confirma
        // con {t:'seg_ack'} que ese aid llegó completo, o por el tope
        // defensivo de memoria (16 MB ≈ 35 min de voz).
        this._vozTxFaseAct = null;
        return;
      }
      // tope de seguridad ~16 MB (≈35 min de voz): suelta la frase
      // más vieja conservando siempre la actual
      while (this._vozTxBytes > 16777216 && this._vozTxFases.length > 1) {
        this._soltarVozFase(this._vozTxFases[0]);
      }
    }

    _soltarVozFase(fase) {
      const i = this._vozTxFases.indexOf(fase);
      if (i >= 0) this._vozTxFases.splice(i, 1);
      for (const c of fase) {
        const p = this._vozTxPend.get(c);
        if (p) { this._vozTxBytes -= p.length; this._vozTxPend.delete(c); }
      }
      if (this._vozTxFaseAct === fase) this._vozTxFaseAct = null;
    }

    // Nueva sesión de micro = txSeq vuelve a 0: las pendientes de la sesión
    // vieja chocarían con los tx nuevos — se descartan (ya no atribuibles)
    _resetVozTxPend() {
      this._vozTxPend.clear();
      this._vozTxFases.length = 0;
      this._vozTxFaseAct = null;
      this._vozTxBytes = 0;
    }

    // El servidor pide los txs que le faltan: se reenvían desde el buffer
    // por su propio POST (al frente de la cola — destraban la frase)
    _reenviosVoz(txs) {
      if (!Array.isArray(txs)) return;
      const lista = [];
      let n = 0;
      for (const t of txs) {
        const tx = Number(t) & 0xffff;
        for (let fam = 0; fam < 2; fam++) {
          const pkt = this._vozTxPend.get((tx << 1) | fam);
          if (pkt) lista.push(pkt);
        }
        if (++n >= 96) break;
      }
      this._postVozFrames(lista);
    }

    // El servidor confirma ({t:'seg_ack'}) que recibió completo ese audio
    // (aid): se suelta su semilla de retransmisión. Protocolo semilla P2P —
    // conservar cada audio hasta que el otro extremo confirme recepción.
    _ackVoz(aid) {
      aid = Number(aid) & 0x0f;
      if (!aid || !this._vozTxPend.size) return;
      // clave = (tx<<1)|fam → aid = tx>>12 = clave>>13
      for (const [k, p] of this._vozTxPend) {
        if (((k >> 13) & 0x0f) === aid) {
          this._vozTxPend.delete(k);
          this._vozTxBytes -= p.length;
        }
      }
      for (const fase of this._vozTxFases) {
        for (let i = fase.length - 1; i >= 0; i--) {
          if (((fase[i] >> 13) & 0x0f) === aid) fase.splice(i, 1);
        }
      }
      this._vozTxFases = this._vozTxFases.filter(f => f.length);
    }

    // ACK parcial por trozo ({contig} en la respuesta del POST): el servidor
    // ya archivó contiguas las tramas 0..contigIdx de ese aid — no las va a
    // volver a pedir, así que se sueltan de la semilla de retransmisión
    _soltarSemillaHasta(aid, contigIdx) {
      aid = Number(aid) & 0x0f;
      if (!aid || !this._vozTxPend.size) return;
      for (const [k, p] of this._vozTxPend) {
        const tx = k >> 1;
        if (((tx >> 12) & 0x0f) === aid && (tx & 0x0fff) <= contigIdx) {
          this._vozTxPend.delete(k);
          this._vozTxBytes -= p.length;
        }
      }
      for (const fase of this._vozTxFases) {
        for (let i = fase.length - 1; i >= 0; i--) {
          const tx = fase[i] >> 1;
          if (((tx >> 12) & 0x0f) === aid && (tx & 0x0fff) <= contigIdx) fase.splice(i, 1);
        }
      }
      this._vozTxFases = this._vozTxFases.filter(f => f.length);
    }

    // Tras reconectar, TODO lo enviado que el servidor no llegó a confirmar
    // puede haber muerto en el socket anterior — se reenvía completo; él
    // deduplica por tx e inserta en orden, así no hay dobles ni desorden
    _reenvioVozPendiente() {
      if (!this._vozTxPend.size) return;
      const claves = [...this._vozTxPend.keys()].sort((a, b) => {
        const ta = a >> 1, tb = b >> 1;
        return (((ta - tb) & 0xffff) < 30000) ? -1 : 1;
      });
      this._postVozFrames(claves.map((c) => this._vozTxPend.get(c)));
    }

    _drenarTx() {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
      // Control primero: soltar/tomar el piso jamás espera la voz acumulada
      while (this._ctrlCola.length) {
        const c = this._ctrlCola.shift();
        try { this._ws.send(c); } catch { this._ctrlCola.unshift(c); break; }
      }
      // Drenar hasta 64 KB por tanda para que las ráfagas salgan fluidas
      while (this._txCola.length && this._ws.bufferedAmount < 64 * 1024) {
        const p = this._txCola.shift();
        this._txBytes -= p.length;
        try { this._ws.send(p); } catch {
          this._txCola.unshift(p);
          this._txBytes += p.length;
          break;
        }
      }
      if (this._txCola.length) this._programarFlushTx();
    }

    // ---------- subida de voz por HTTP en trozos independientes ----------
    // La voz del emisor viaja en ráfagas de ~1 s, cada una por su propio POST:
    // si una conexión se atasca o muere, solo ese trozo espera y se reintenta
    // por otra conexión. El servidor las archiva en orden por su número tx y
    // las piezas que falten las re-pide con {t:'falta'} — la voz llega siempre.
    _subirAudioPkt(pkt) {
      if (!pkt || pkt[0] !== 0x01 || pkt.length < 2) return;
      this._registrarVozTx(pkt);
      // en el body viaja el payload sin el byte inicial de tipo de trama
      this._chunkTx.push(pkt.subarray(1));
      if (this._chunkTx.length >= 25) { // ~1 s de voz (25 x 40 ms)
        this._flushChunk();
      } else if (!this._chunkFlushT) {
        this._chunkFlushT = setTimeout(() => {
          this._chunkFlushT = null;
          this._flushChunk();
        }, 1100);
      }
    }

    // Arma el cuerpo binario de un POST: [u8 ver=1][u16 n][u16 len][trama]*n
    // Acepta paquetes completos (con el byte 0x01 inicial) o payloads sueltos.
    _armarBodyVoz(pkts) {
      const fr = [];
      let total = 3;
      for (const p of pkts) {
        const f = (p.length > 1 && p[0] === 0x01) ? p.subarray(1) : p;
        fr.push(f);
        total += 2 + f.length;
      }
      const body = new Uint8Array(total);
      body[0] = 1;
      body[1] = (fr.length >> 8) & 0xff;
      body[2] = fr.length & 0xff;
      let o = 3;
      for (const f of fr) {
        body[o] = (f.length >> 8) & 0xff;
        body[o + 1] = f.length & 0xff;
        body.set(f, o + 2);
        o += 2 + f.length;
      }
      return body;
    }

    _flushChunk() {
      if (this._chunkFlushT) {
        clearTimeout(this._chunkFlushT);
        this._chunkFlushT = null;
      }
      if (!this._chunkTx.length) return;
      const frames = this._chunkTx;
      this._chunkTx = [];
      this._encolarSubida(this._armarBodyVoz(frames));
    }

    // Reenvío de tramas sueltas que el servidor pide por 'falta': van al
    // FRENTE de la cola de subida — rellenar el hueco destraba la frase.
    _postVozFrames(pkts) {
      if (!pkts || !pkts.length) return;
      let lote = [];
      let bytes = 3;
      const emitir = () => {
        if (lote.length) this._encolarSubida(this._armarBodyVoz(lote), true);
        lote = [];
        bytes = 3;
      };
      for (const p of pkts) {
        if (bytes + 2 + p.length > 3 * 1024 * 1024) emitir();
        lote.push(p);
        bytes += 2 + p.length;
      }
      emitir();
    }

    _encolarSubida(body, alFrente) {
      if (!body || !body.length) return;
      // tope defensivo ~4 MB en cola (≈7 min de voz a 10 kbps)
      let bytes = 0;
      for (const b of this._chunkPend) bytes += b.length;
      while (bytes > 4 * 1024 * 1024 && this._chunkPend.length) {
        bytes -= this._chunkPend[0].length;
        this._chunkPend.shift();
      }
      if (alFrente) this._chunkPend.unshift(body); else this._chunkPend.push(body);
      this._lanzarSubida();
    }

    // fetch a /api de audio con token vivo: un 401 renueva el token de
    // sala (la sesión del login sigue viva aunque el token expire) y
    // reintenta UNA vez — sin esto un token viejo tiraba los trozos en
    // silencio y no quedaba ni segmento ni historial
    async _fetchAuth(url, opts) {
      const conTok = () => ({
        ...(opts || {}),
        headers: { ...((opts && opts.headers) || {}), Authorization: 'Bearer ' + ((window.S && window.S.token) || '') },
      });
      let r = await fetch(url, conTok());
      if (r.status === 401 && window._refrescarToken) {
        try { await window._refrescarToken(); } catch {}
        r = await fetch(url, conTok());
      }
      return r;
    }

    _lanzarSubida() {
      const sala = (window.S && window.S.sala) || '';
      const tok = (window.S && window.S.token) || '';
      if (!sala || !tok) {
        this._programarRetrySubida();
        return;
      }
      while (this._chunkEnVuelo < 4 && this._chunkPend.length) {
        const body = this._chunkPend.shift();
        this._chunkEnVuelo++;
        fetch(`/api/salas/${encodeURIComponent(sala)}/audio/subir`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + tok,
            'Content-Type': 'application/octet-stream',
          },
          body,
        }).then(async (r) => {
          this._chunkEnVuelo--;
          // 409 (socket de medios aún no conectado) y 5xx: reintentar el
          // trozo por otra conexión; un 401 renueva el token y reencola —
          // NUNCA soltar el trozo: es voz del usuario y perderla corta la
          // frase y el historial
          if (r.status === 409 || r.status >= 500) {
            this._chunkPend.unshift(body);
            this._programarRetrySubida();
          } else if (r.status === 401) {
            this._chunkPend.unshift(body);
            console.warn('[voz] subir 401 — renovando token y reintentando');
            const ahora = Date.now();
            if (!this._ultRefTok || ahora - this._ultRefTok > 10000) {
              this._ultRefTok = ahora;
              if (window._refrescarToken) {
                try { await window._refrescarToken(); } catch {}
              }
            }
            this._programarRetrySubida();
          } else if (r.ok) {
            // ACK del trozo: el servidor confirma hasta qué índice contiguo
            // ya archivó — esa parte de la semilla jamás se vuelve a pedir
            try {
              const j = await r.json();
              if (j && j.aid && j.contig >= 0) {
                this._soltarSemillaHasta(j.aid, j.contig);
              }
            } catch {}
          } else {
            // 4xx que no se recupera solo (400 cuerpo inválido, 410
            // purgado…): queda en el log — antes se tragaba en silencio
            console.warn('[voz] subir descartó trozo: HTTP', r.status);
          }
          this._lanzarSubida();
        }).catch(() => {
          this._chunkEnVuelo--;
          this._chunkPend.unshift(body);
          this._programarRetrySubida();
        });
      }
    }

    _programarRetrySubida() {
      if (this._chunkRetryT) return;
      this._chunkRetryT = setTimeout(() => {
        this._chunkRetryT = null;
        this._lanzarSubida();
      }, 900);
    }

    // ---------- piso exclusivo (PTT) ----------
    // Cada pulsación de PTT asigna un identificador de audio nuevo (aid 1..15)
    // y tanto piso_tomar como piso_soltar llevan ese mismo aid para que el
    // servidor nunca confunda el soltar del audio 1 con el pisar del audio 2.
    tomarPiso() {
      // Un soltar diferido quedaba en camino: se cancela — sigo hablando
      if (this._sueltaProgT) { clearTimeout(this._sueltaProgT); this._sueltaProgT = null; }
      this._quieroPiso = true;
      this._vozAid = (((this._vozAid || 0) % 15) + 1);
      this._pisoAidAct = this._vozAid;
      this._pisoAidPend = this._vozAid;
      this._enviarJson({ t: 'piso_tomar', aid: this._pisoAidAct }, true);
      this._latidoPiso();
    }

    soltarPiso() {
      this.soltarPisoAid(this._pisoAidAct || this._vozAid || 0);
    }

    // Soltar diferido (~1 s por defecto): el dedo ya se levantó pero el
    // micro sigue capturando — la frase no queda cortada al ras del gesto
    // y la cola del audio gana margen para entrar en los receptores antes
    // de que llegue el seg_fin. Si vuelvo a pisar antes de que venza, se
    // cancela solo (tomarPiso limpia el timer y _quieroPiso queda true).
    programarSoltarPiso(ms) {
      if (this._sueltaProgT) return;
      const aid = this._pisoAidAct || this._vozAid || 0;
      // Marcar la intención de soltar YA: si no, el timer vería _quieroPiso
      // aún true y jamás soltaría (el heartbeat seguiría reteniendo el piso
      // y la frase quedaría abierta hasta el timeout del servidor).
      // tomarPiso() la vuelve true si repiso antes de que venza.
      this._quieroPiso = false;
      this._sueltaProgT = setTimeout(() => {
        this._sueltaProgT = null;
        if (this._quieroPiso) return; // repisé antes de soltar: no suelto nada
        this.soltarPisoAid(aid);
      }, ms == null ? 1000 : ms);
    }

    soltarPisoAid(aidSuelto) {
      if (this._sueltaProgT) { clearTimeout(this._sueltaProgT); this._sueltaProgT = null; }
      this._ultAidSuelto = aidSuelto;
      this._pisoAidPend = 0;
      this._quieroPiso = false;
      this._tengoPiso = false;
      this._marcarHablandoLocal(false);
      if (this._pisoHoldT) { clearInterval(this._pisoHoldT); this._pisoHoldT = null; }
      this._enviarJson({ t: 'piso_soltar', aid: aidSuelto }, true);
      this._flushChunk(); // lo que quede en el trozo en armado sale ya por POST
    }

    // Latido mientras se tiene el piso: el watchdog del servidor lo suelta a
    // los 6 s sin tramas ni latidos (corte de WiFi o pestaña muerta)
    _latidoPiso() {
      if (this._pisoHoldT) return;
      this._pisoHoldT = setInterval(() => {
        if (!this._quieroPiso) {
          clearInterval(this._pisoHoldT);
          this._pisoHoldT = null;
          return;
        }
        this._enviarJson({ t: 'piso_hold' });
      }, 2500);
    }

    // ---------- segmentos de voz ordenados ----------
    _segMeta(seg) {
      return seg ? {
        seq: seg.seq, de: seg.de, nombre: seg.nombre, durMs: seg.durMs,
        inicio: seg.inicio, interrumpida: seg.interrumpida, abierto: seg.abierto,
      } : null;
    }

    // Marca una seq como ya escuchada: el set sobrevive a las reconexiones
    // del socket, así las notas re-descargadas tras un corte se archivan
    // pero no se repiten por el altavoz
    _marcarOido(seq) {
      if (typeof seq !== 'number' || seq <= 0) return;
      this._vozOidos.add(seq);
      if (this._vozOidos.size > 600) {
        this._vozOidos = new Set([...this._vozOidos].slice(-300));
      }
    }

    // Dedup del lado oyente por PEDAZO de audio: cada trama lleva tx
    // (aid+índice) único por hablante. Si el servidor revive una frase ya
    // cerrada como segmento nuevo (reenvío de semilla tras un corte), sus
    // bloques traen txs que YA sonaron — se saltan sin importar el seq o la
    // conexión por la que lleguen. Ventana 90 s: cubre la ráfaga de reenvío
    // tras reconectar y queda por debajo de los ~164 s que tarda el
    // contador de trama (12 bits) en dar la vuelta, así el segundo paso de
    // un monólogo larguísimo con los mismos números jamás se descarta.
    _txYaSono(de, tx) {
      const m = this._txOidos.get(de);
      if (!m) return false;
      const t = m.get(tx);
      if (t == null) return false;
      if (performance.now() - t > 90000) { m.delete(tx); return false; }
      return true;
    }

    _txMarcarSono(de, tx) {
      if (!de) return;
      let m = this._txOidos.get(de);
      if (!m) { m = new Map(); this._txOidos.set(de, m); }
      m.set(tx, performance.now());
      if (m.size > 3000) {
        const viejo = performance.now() - 90000;
        for (const [k, t] of m) { if (t < viejo) m.delete(k); }
        if (m.size > 3000) {
          let n = 0;
          for (const k of m.keys()) { m.delete(k); if (++n > 1000) break; }
        }
      }
    }

    _vozSegNuevo(seq, de, nombre, abierto, meta) {
      let seg = this._vozSegs.get(seq);
      if (!seg) {
        seg = {
          seq, de: de || '', nombre: nombre || de || '',
          abierto: !!abierto, completo: !abierto, finLocal: !abierto,
          propio: !!de && de === this.localParticipant.identity,
          pseudo: false,
          durMs: (meta && meta.durMs) || 0,
          interrumpida: !!(meta && (meta.interrumpida || meta.cortado)),
          inicio: (meta && meta.inicio) || Date.now(),
          bloques: [], vistos: new Set(), ultTx: -1, huecos: false,
          alimentado: 0, bajando: false, descargado: false, perdido: false,
          saltado: false, reproducido: false, finAvisado: false, bajaDesde: 0,
          _repT: null, raw: [], rawBytes: 0, ultRxT: performance.now(),
        };
        this._vozSegs.set(seq, seg);
        let i = this._vozOrden.length;
        while (i > 0 && (this._vozOrden[i - 1].pseudo ? Infinity : this._vozOrden[i - 1].seq) > seq) i--;
        this._vozOrden.splice(i, 0, seg);
      } else {
        if (de && !seg.de) seg.de = de;
        if (de) seg.propio = de === this.localParticipant.identity;
        if (nombre) seg.nombre = nombre;
        // el servidor la da por cerrada: también el borde local, o la frase
        // queda abierta bloqueando la cabeza de la cola en vivo para siempre
        if (!abierto) { seg.completo = true; seg.finLocal = true; }
        if (meta && meta.durMs) seg.durMs = meta.durMs;
        if (meta && (meta.interrumpida || meta.cortado)) seg.interrumpida = true;
        if (meta && meta.inicio) seg.inicio = meta.inicio;
      }
      if (abierto && de) this._segPorHablante.set(de, seq);
      if (typeof seq === 'number' && seq > 0) this._ultimoSeg = Math.max(this._ultimoSeg, seq);
      if (typeof seq === 'number' && seq > 0 && this._vozOidos.has(seq)) {
        seg.reproducido = true; // ya sonó: se archiva/actualiza pero no se repite
      }
      return seg;
    }

    // Segmento implícito: llegaron tramas antes que el seg_ini (reorden del
    // canal de control). Se re-etiqueta con su seq real cuando llega seg_ini.
    _segImplicito(fromId) {
      const cur = this._segPorHablante.get(fromId);
      if (cur != null) {
        const seg = this._vozSegs.get(cur);
        if (seg) return seg;
      }
      const seq = -(++this._pseudoN);
      const p = this.remoteParticipants.get(fromId);
      const seg = {
        seq, pseudo: true, de: fromId,
        nombre: (p && (p.name || p.identity)) || fromId,
        abierto: true, completo: false, finLocal: false,
        durMs: 0, interrumpida: false, inicio: Date.now(),
        bloques: [], vistos: new Set(), ultTx: -1, huecos: false,
        alimentado: 0, bajando: false, descargado: false, perdido: false,
        saltado: false, reproducido: false, finAvisado: false, bajaDesde: 0,
        _repT: null, raw: [], rawBytes: 0,
      };
      this._vozSegs.set(seq, seg);
      this._segPorHablante.set(fromId, seq);
      this._vozOrden.push(seg); // los pseudo van al final
      return seg;
    }

    // Inserta un bloque decodificado en el segmento, ordenado por su índice
    // de trama dentro del audio (0, 1, 2... = bl.tx & 0x0fff).
    _insertarBloque(seg, bl) {
      seg.ultRxT = performance.now(); // watchdog de frase abierta
      if (typeof bl.tx !== 'number' || bl.tx < 0) {
        seg.bloques.push(bl);
        return;
      }
      const idx = bl.tx & 0x0fff;
      let i = seg.bloques.length;
      while (i > 0 && (((seg.bloques[i - 1].tx & 0x0fff) - idx) & 0x0fff) < 2048) i--;
      seg.bloques.splice(i, 0, bl);
      if (i < seg.alimentado) {
        seg.alimentado++;
      } else if (seg.reproducido &&
                 performance.now() - (seg._finT || 0) < 45000) {
        // Frase marcada "reproducida" cuyo seg_fin llegó por WS antes que
        // sus últimos trozos por HTTP: la pieza tardía cae al borde aún
        // no escuchado → se reabre para terminar de sonar. Los huecos
        // internos rellenados después quedan atrás y no repiten audio
        console.log('[voz] seg', seg.seq, 'REABIERTA por trama tardía idx',
          bl.tx & 0x0fff);
        seg.reproducido = false;
        seg.finAvisado = false;
      }
    }

    _programarReparacion(seg) {
      if (seg._repT || seg.bajando || seg.descargado) return;
      seg._repT = setTimeout(() => {
        seg._repT = null;
        if (seg.seq > 0) this._bajarSeg(seg.seq);
      }, 250);
    }

    // Trama de voz en vivo ya decodificada y remuestreada: entra a la cola
    // ordenada del segmento del hablante (identificado por su aid).
    _alimentarSegVoz(fromId, pcm, txSeq, crudo) {
      if (!pcm || !pcm.length) return;
      const aid = (typeof txSeq === 'number' && txSeq >= 0) ? ((txSeq >> 12) & 0x0f) : 0;
      const idx = (typeof txSeq === 'number' && txSeq >= 0) ? (txSeq & 0x0fff) : -1;
      let seg = null;
      const seq = this._segPorHablante.get(fromId);
      if (seq != null) seg = this._vozSegs.get(seq) || null;
      // Si la trama trae un aid distinto al del segmento abierto (o pertenece
      // a un segmento anterior que aún estaba completándose), buscar ese
      // segmento por aid o abrir uno nuevo para no mezclar dos audios.
      if (seg && aid > 0 && seg.aid && seg.aid !== aid) {
        let encontrado = null;
        for (let k = this._vozOrden.length - 1; k >= 0; k--) {
          const cand = this._vozOrden[k];
          if (cand.de === fromId && cand.aid === aid) { encontrado = cand; break; }
        }
        if (encontrado) {
          seg = encontrado;
        } else {
          seg.finLocal = true;
          this._segPorHablante.delete(fromId);
          seg = null;
        }
      }
      if (!seg) seg = this._segImplicito(fromId);
      if (aid > 0 && !seg.aid) seg.aid = aid;

      if (typeof txSeq === 'number' && txSeq >= 0) {
        if (seg.vistos.has(txSeq)) return;
        seg.vistos.add(txSeq);
        if (seg.ultTx >= 0) {
          const ultIdx = seg.ultTx & 0x0fff;
          const diff = (idx - ultIdx) & 0x0fff;
          if (diff > 1 && diff < 2048) {
            seg.huecos = true;
            this._programarReparacion(seg);
          }
        } else if (idx > 0) {
          // Faltaron las tramas iniciales (0 .. idx-1) de este audio
          seg.huecos = true;
          this._programarReparacion(seg);
        }
        if (seg.ultTx < 0 || ((idx - (seg.ultTx & 0x0fff)) & 0x0fff) < 2048) seg.ultTx = txSeq;
      }
      this._insertarBloque(seg, { tx: txSeq, pcm });
      if (crudo && seg.rawBytes < 4194304) {
        seg.raw.push(crudo.slice());
        seg.rawBytes += crudo.length;
      }
      // nivel RMS para el marcador de "hablando"
      let sum = 0;
      for (let i = 0; i < pcm.length; i += 8) sum += pcm[i] * pcm[i];
      if (Math.sqrt(sum / Math.max(1, Math.ceil(pcm.length / 8))) > 0.006) {
        this._speakers.set(fromId, Date.now() + 650);
        this._actualizarSpeakers();
      }
      this._programarFeedOn();
    }

    // ---------- reproductor único ordenado ----------
    _asegurarVozPipe() {
      if (this._vozPipe) return this._vozPipe;
      const ctx = this._asegurarRxAudioCtx();
      const ctxRate = ctx.sampleRate || 48000;
      this._vozRate = ctxRate;
      const cap = Math.ceil(ctxRate * 30);
      const gainNode = ctx.createGain();
      gainNode.gain.value = 1.0;
      gainNode.connect(ctx.destination);
      const pipe = {
        ctx, ctxRate, gainNode, worklet: null, proc: null,
        ring: new Float32Array(cap), cap,
        writePos: 0, readPosF: 0, available: 0, playing: false,
        eosPending: true, waitSamples: 0, underrunSamples: 0,
        lastOut: 0, fadeInPos: 0, fadeInLen: Math.ceil(ctxRate * 0.005),
        readRate: 1.0, velMax: 1.0, eosSent: true,
        targetSamples: Math.ceil(ctxRate * 0.3),
      };
      this._vozPipe = pipe;

      const conectarWorklet = () => {
        if (pipe.worklet || !ctx._workletListo || typeof window.AudioWorkletNode !== 'function') return false;
        try {
          const wn = new window.AudioWorkletNode(ctx, 'conferencia-rx-worklet', {
            numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
          });
          wn.connect(gainNode);
          pipe.worklet = wn;
          try {
            wn.port.postMessage({ t: 'cap', ms: 28000 });
            wn.port.postMessage({ t: 'target', ms: 400 });
          } catch {}
          if (pipe.proc) { try { pipe.proc.disconnect(); } catch {} pipe.proc = null; }
          return true;
        } catch { return false; }
      };

      if (!conectarWorklet()) {
        const proc = ctx.createScriptProcessor(2048, 1, 1);
        proc.onaudioprocess = (ev) => {
          const out = ev.outputBuffer.getChannelData(0);
          const n = out.length;
          if (!pipe.playing) {
            if (pipe.available > 0) {
              pipe.waitSamples += n;
              if (pipe.available >= pipe.targetSamples || pipe.eosPending ||
                  pipe.waitSamples >= pipe.ctxRate * 0.08) {
                pipe.playing = true; pipe.waitSamples = 0;
                pipe.underrunSamples = 0; pipe.fadeInPos = 0;
              }
            } else {
              pipe.waitSamples = 0;
            }
            if (!pipe.playing) { for (let i = 0; i < n; i++) out[i] = 0; return; }
          }
          for (let i = 0; i < n; i++) {
            if (pipe.available >= 1) {
              const idx0 = pipe.readPosF | 0;
              let s = pipe.ring[idx0];
              pipe.readPosF = (idx0 + 1) % pipe.cap;
              pipe.available -= 1;
              if (pipe.fadeInPos < pipe.fadeInLen) { s *= pipe.fadeInPos / pipe.fadeInLen; pipe.fadeInPos++; }
              out[i] = s; pipe.lastOut = s; pipe.underrunSamples = 0;
            } else {
              pipe.lastOut *= 0.982;
              if (Math.abs(pipe.lastOut) < 0.0001) pipe.lastOut = 0;
              out[i] = pipe.lastOut;
              pipe.underrunSamples++;
              if (pipe.eosPending || pipe.underrunSamples > pipe.ctxRate * 0.4) {
                pipe.playing = false; pipe.eosPending = false;
                pipe.waitSamples = 0; pipe.available = 0;
                pipe.readPosF = pipe.writePos;
                for (let k = i + 1; k < n; k++) out[k] = 0;
                return;
              }
            }
          }
        };
        proc.connect(gainNode);
        pipe.proc = proc;
        asegurarWorkletEnCtx(ctx).then((ok) => {
          if (ok && this._vozPipe === pipe) conectarWorklet();
        });
      }
      return pipe;
    }

    _vozEmpujar(pcm) {
      const pipe = this._vozPipe;
      if (!pipe) return;
      this._vozBufMs += (pcm.length / pipe.ctxRate) * 1000;
      if (pipe.worklet) {
        try {
          // sin transferencia: el bloque sigue vivo en el segmento para
          // poder re-escucharlo o subirlo al historial local
          pipe.worklet.port.postMessage({ t: 'push', pcm });
          return;
        } catch {}
      }
      // fallback: ring buffer de 30 s del ScriptProcessor (sin descartar voz)
      const ring = pipe.ring, cap = pipe.cap;
      for (let i = 0; i < pcm.length && pipe.available < cap; i++) {
        ring[pipe.writePos] = pcm[i];
        pipe.writePos = (pipe.writePos + 1) % cap;
        pipe.available++;
      }
    }

    // Corazón de la reproducción ordenada: corre cada 60 ms. Alimenta el
    // reproductor único siempre a velocidad natural 1.0x (cero aceleración),
    // uniendo los trozos por número tx antes de sonar y autorregulando el
    // colchón según el bache real de la red móvil.
    _feedVoz() {
      const ahoraMs = performance.now();
      const dt = Math.min(250, ahoraMs - (this._feedUltimo || ahoraMs));
      this._feedUltimo = ahoraMs;
      const pipe = this._asegurarVozPipe();
      this._vozBufMs = Math.max(0, this._vozBufMs - dt);

      // 1. Notas re-escuchadas tienen prioridad y suenan a velocidad 1.0x
      while (this._replayQ.length && this._vozBufMs < 2000) {
        const rp = this._replayQ[0];
        while (rp.alimentado < rp.bloques.length && this._vozBufMs < 2000) {
          const bl = rp.bloques[rp.alimentado++];
          this._vozEmpujar(bl.pcm);
          this._replayPendMs += (bl.pcm.length / pipe.ctxRate) * 1000;
        }
        if (rp.alimentado >= rp.bloques.length) this._replayQ.shift();
        else break;
      }
      if (this._replayPendMs > 0) {
        const paso = Math.min(this._replayPendMs, dt);
        this._replayPendMs -= paso;
        this._replayPlayedMs += paso;
      }
      while (this._replayProg.length &&
             this._replayPlayedMs >= this._replayProg[0].finMs - 30) {
        this.emit('seg_replay_fin', this._replayProg.shift().seq);
      }
      if (!this._replayProg.length && !this._replayQ.length &&
          this._replayPendMs <= 30) {
        this._replayPendMs = 0;
        this._replayPlayedMs = 0;
      }
      if (this._replayProg.length && ahoraMs - (this._progUltimo || 0) > 200) {
        this._progUltimo = ahoraMs;
        const rp = this._replayProg[0];
        const pos = (rp.baseMs || 0) + Math.max(0, Math.min(rp.remMs,
          this._replayPlayedMs - (rp.finMs - rp.remMs)));
        this.emit('seg_progreso',
          { seq: rp.seq, posMs: Math.round(pos), durMs: Math.round(rp.msTotal) });
      }

      // 2. Cabeza de la cola ordenada por seq: arranca de inmediato (sin
      // colchón artificial). Si hubo un bache de 10 o 30 s, al llegar la
      // ráfaga se guarda entera en seg.bloques (sin límite de duración,
      // jamás se descarta nada) y _feedVoz la va pasando al altavoz a 1.0x:
      // esa misma ráfaga que suena a tiempo real ES el buffer natural que
      // cubre los siguientes baches.
      let seg = null;
      for (const s of this._vozOrden) {
        // la frase propia se archiva en el chat pero jamás suena en vivo
        if (s.saltado || s.reproducido || s.propio) continue;
        seg = s;
        break;
      }
      if (seg) {
        if (seg.bajando) {
          // esperar la descarga; >16 s se declara perdida (el fetch tiene
          // timeout propio de 12 s — no matarla antes de que aborte)
          if (ahoraMs - seg.bajaDesde > 16000) {
            seg.bajando = false;
            seg.perdido = true;
            seg.saltado = true;
            console.log('[voz] seg', seg.seq, 'PERDIDA: bajando >8s, alimentado',
              seg.alimentado, '/', seg.bloques.length);
            this.emit('seg_perdido', seg.seq);
          }
        } else {
          if (this._vozHeadSeq !== seg.seq) {
            this._vozHeadSeq = seg.seq;
            const vf = typeof window.volEfectivo === 'function'
              ? window.volEfectivo(seg.de)
              : (this._volPorId.get(seg.de) || 1);
            try { pipe.gainNode.gain.value = Math.max(0, Math.min(3, vf)); } catch {}
            this.emit('seg_reproduciendo', this._segMeta(seg));
          }
          // Mantener ~3,5 s alimentados en el AudioWorklet mientras el resto
          // de la ráfaga (sean 30 s o 5 min) espera íntegro en seg.bloques:
          // colchón profundo contra el jitter de redes móviles
          while (seg.alimentado < seg.bloques.length && this._vozBufMs < 3500) {
            const bl = seg.bloques[seg.alimentado];
            // Ensamblado en secuencia estricta desde idx=0: si falta la trama 0
            // o un idx intermedio de este audio, pedir la pieza faltante al
            // servidor (reintentando cada 800 ms) y esperar a que encaje.
            if (typeof bl.tx === 'number' && bl.tx >= 0) {
              // Este pedazo de ESTE hablante ya salió por el altavoz: la
              // frase revivida con otro seq se drena sin sonar otra vez
              if (this._txYaSono(seg.de, bl.tx)) { seg.alimentado++; continue; }
              const idx = bl.tx & 0x0fff;
              const espIdx = typeof seg.ultTxEmp === 'number' ? ((seg.ultTxEmp + 1) & 0x0fff) : 0;
              const diff = (idx - espIdx) & 0x0fff;
              if (diff > 0 && diff < 2048 && !seg.descargado) {
                if (!seg._huecoDesde) seg._huecoDesde = ahoraMs;
                if (!seg._ultRepIntento || ahoraMs - seg._ultRepIntento > 800) {
                  seg._ultRepIntento = ahoraMs;
                  this._programarReparacion(seg);
                }
                // >2.5 s esperando la pieza: el vivo salta el hueco; el
                // .seg descargado la reincorpora íntegra en el archivo
                if (ahoraMs - seg._huecoDesde < 2500) {
                  break;
                }
              }
            }
            seg._huecoDesde = 0;
            if (typeof bl.tx === 'number' && bl.tx >= 0) {
              seg.ultTxEmp = bl.tx & 0x0fff;
              this._txMarcarSono(seg.de, bl.tx);
            }
            seg.alimentado++;
            this._vozEmpujar(bl.pcm);
          }
          if (seg.alimentado >= seg.bloques.length &&
              (seg.completo || seg.finLocal) && !seg.finAvisado) {
            seg.finAvisado = true;
            seg.reproducido = true;
            seg._finT = ahoraMs; // ventana para que una cola tardía reabra
            console.log('[voz] seg', seg.seq, 'marcada reproducida: alimentado',
              seg.alimentado, '/', seg.bloques.length);
            this._marcarOido(seg.seq);
            this.emit('seg_reproducido', this._segMeta(seg));
          }
        }
      }

      // 3. Sin aceleración: velocidad siempre 1.0x natural. Solo medimos el
      // retraso real para mostrárselo al usuario en el botón "Ir al presente"
      // por si quiere adelantar manualmente.
      const retraso = this._retrasoMs();
      this._velAct = 1.0;
      this._drenando = false;
      if (retraso !== this._retrasoAviso) {
        this._retrasoAviso = retraso;
        this.emit('voz_retraso', Math.round(retraso));
      }

      // 4. Cola vacía: marcar EOS para que el reproductor termine limpio
      const vacio = !seg && !this._replayQ.length && !this._replayProg.length;
      if (vacio && !pipe.eosSent) {
        pipe.eosSent = true;
        console.log('[voz] cola vacía → eos al worklet (bufMs=' +
          Math.round(this._vozBufMs) + ')');
        if (pipe.worklet) {
          try { pipe.worklet.port.postMessage({ t: 'eos' }); } catch {}
        } else {
          pipe.eosPending = true;
        }
      } else if (!vacio) {
        pipe.eosSent = false;
      }

      // 5. Liberar memoria de segmentos ya escuchados hace >10 min
      const viejo = Date.now() - 600000;
      const ahoraPerf = performance.now();
      for (const s of this._vozOrden) {
        // Frase abierta sin tramas hace >4 s: su EOS/seg_fin se perdió (el
        // servidor ya la cerró por inactividad a ~1,6 s). Pedir al servidor
        // el segmento completo: rellena la cola que faltó Y el archivo
        // confirma el fin (abierto=false). Si no, queda en la cabeza y mata
        // TODO el audio en vivo detrás. Si sigue abierta en el servidor, se
        // reintenta en otros 4 s — la descarga marca ultRxT de nuevo
        if (!s.saltado && !s.reproducido && !s.completo && !s.finLocal &&
            !s.bajando && ahoraPerf - (s.ultRxT || 0) > 4000) {
          if (!s.pseudo && s.seq > 0) {
            this._bajarSeg(s.seq);
          } else {
            s.finLocal = true;
            if (this._segPorHablante.get(s.de) === s.seq) this._segPorHablante.delete(s.de);
          }
        }
        // Sondeo de tramos: mientras la frase siga abierta en el servidor se
        // baja la racha contigua cada ~700 ms aunque el aviso 'chunk' se
        // haya perdido en la red — el orden lo impone siempre el cliente
        if (!s.saltado && !s.reproducido && !s.completo &&
            !s.pseudo && !s.propio && s.seq > 0 &&
            ahoraPerf - (s._ultTramoT || 0) > 700) {
          this._bajarTramos(s);
        }
        if ((s.reproducido || s.saltado || s.propio) &&
            s.inicio < viejo && s.bloques.length) {
          s.bloques = [];
          s.vistos.clear();
        }
      }
    }

    _programarFeedOn() {
      if (this._feedT) return;
      this._feedUltimo = performance.now();
      this._feedT = setInterval(() => this._feedVoz(), 60);
    }

    _retrasoMs() {
      let ms = this._vozBufMs;
      for (const s of this._vozOrden) {
        if (s.saltado || s.reproducido) continue;
        for (let i = s.alimentado; i < s.bloques.length; i++) {
          ms += (s.bloques[i].pcm.length / this._vozRate) * 1000;
        }
      }
      return ms;
    }

    // Salta todo el historial pendiente y sigue en la frase que está en vivo
    saltarAlPresente() {
      for (const s of this._vozOrden) {
        if (s.reproducido || s.saltado) continue;
        if (!s.completo && !s.finLocal) {
          s.alimentado = s.bloques.length; // seguir la frase actual desde su borde
        } else {
          s.saltado = true;
          this._marcarOido(s.seq); // "ir al presente" también recuerda: no repetir
        }
      }
      this._replayQ.length = 0;
      this._replayProg.length = 0;
      this._replayPendMs = 0;
      this._replayPlayedMs = 0;
      // "Ir al presente" también suelta las notas pausadas
      if (this._replayPausas) {
        for (const seq of this._replayPausas.keys()) this.emit('seg_replay_fin', seq);
        this._replayPausas.clear();
      }
      this._vozBufMs = 0;
      const pipe = this._vozPipe;
      if (pipe) {
        if (pipe.worklet) {
          try { pipe.worklet.port.postMessage({ t: 'limpiar' }); } catch {}
        } else {
          pipe.writePos = 0; pipe.readPosF = 0; pipe.available = 0;
          pipe.playing = false; pipe.eosPending = false; pipe.waitSamples = 0;
        }
      }
      this._retrasoAviso = 0;
      this.emit('voz_retraso', 0);
    }

    retrasoMs() { return this._retrasoMs(); }

    setAutoPresente(v) { this._autoPresente = !!v; }

    // ---------- descarga de segmentos por HTTP (relleno de huecos) ----------
    async _bajarSeg(seq) {
      if (seq <= 0 || this._fetchSegs.has(seq) || !window.S || !window.S.sala) return;
      this._fetchSegs.add(seq);
      const seg = this._vozSegs.get(seq);
      // Solo se pausa el vivo esperando frases AÚN abiertas; una cerrada
      // rellena en segundo plano sin bloquear la cola que está sonando
      if (seg && !seg.completo) { seg.bajando = true; seg.bajaDesde = performance.now(); }
      const ctrl = new AbortController();
      const ctrlT = setTimeout(() => { try { ctrl.abort(); } catch {} }, 12000);
      try {
        const r = await this._fetchAuth(
          `/api/salas/${encodeURIComponent(window.S.sala)}/audio/${seq}`,
          { signal: ctrl.signal });
        if (!r.ok) {
          if (seg) {
            seg.bajando = false;
            seg.completo = true;
            seg.finLocal = true;
            if (!seg.bloques.length) { seg.perdido = true; seg.saltado = true; }
          }
          return;
        }
        const buf = new Uint8Array(await r.arrayBuffer());
        const parsed = parsearArchivoSeg(buf);
        if (!parsed) {
          if (seg) {
            seg.bajando = false;
            seg.completo = true;
            seg.finLocal = true;
            if (!seg.bloques.length) seg.saltado = true;
          }
          return;
        }
        const sg = seg || this._vozSegNuevo(
          parsed.sg.seq, parsed.sg.de, parsed.sg.nombre, parsed.sg.abierto, parsed.sg);
        if (parsed.sg.de && parsed.sg.abierto) this._segPorHablante.set(parsed.sg.de, sg.seq);
        // La frase propia solo se archiva (raw + IndexedDB): no se decodifica
        // a la cola en vivo para no oírme a mí mismo con retraso
        const nuevos = sg.propio ? [] : await this._decodificarFramesSeg(parsed.frames, sg);
        if (nuevos.length || (parsed.frames && parsed.frames.length)) {
          console.log('[voz] .seg bajado', seq, ':', (parsed.frames || []).length,
            'tramas →', nuevos.length, 'nuevas | alimentado',
            sg.alimentado, '/', sg.bloques.length, 'reproducido', sg.reproducido);
        }
        for (const b of nuevos) {
          if (typeof b.tx === 'number' && b.tx >= 0) {
            if (sg.vistos.has(b.tx)) continue;
            sg.vistos.add(b.tx);
          }
          this._insertarBloque(sg, b);
        }
        this._avanzarProxIdx(sg);
        if (parsed.frames && parsed.frames.length) {
          sg.raw = parsed.frames.map(f => f.slice());
          sg.rawBytes = sg.raw.reduce((a, u) => a + u.length, 0);
        }
        sg.bajando = false;
        sg.descargado = !parsed.sg.abierto;
        if (!parsed.sg.abierto) sg.huecos = false;
        // El archivo completo llegó del servidor: avisar para que la app
        // persista la nota en IndexedDB — en el seg_fin la cola aún podía
        // estar en vuelo e idbGuardarSeg descartaba la copia incompleta.
        // Y toda frase descargada deja su nota en el chat aunque su
        // seg_ini/seg_fin por WS se hayan perdido en un corte.
        if (sg.descargado) this.emit('seg_archivado', seq);
        this.emit(parsed.sg.abierto ? 'seg_ini' : 'seg_fin', this._segMeta(sg));
        sg.ultRxT = performance.now(); // si sigue abierta, re-sondear en ~4 s
        if (!parsed.sg.abierto) { sg.completo = true; sg.finLocal = true; }
        if (parsed.sg.durMs) sg.durMs = parsed.sg.durMs;
        if (parsed.sg.cortado) sg.interrumpida = true;
        if (parsed.sg.inicio) sg.inicio = parsed.sg.inicio;
        if (!parsed.sg.abierto && typeof window.idbGuardarArchivo === 'function') {
          try { window.idbGuardarArchivo(parsed); } catch {}
        }
      } catch {
        if (seg) seg.bajando = false;
      } finally {
        clearTimeout(ctrlT);
        this._fetchSegs.delete(seq);
      }
    }

    // Avanza el cursor de descarga contigua del segmento: solo salta los
    // índices que YA están en bloques — si falta una pieza el cursor se
    // queda en ella y la próxima bajada la re-pide hasta que llegue.
    _avanzarProxIdx(seg) {
      if (seg.proxIdxDesc == null) seg.proxIdxDesc = 0;
      const idxs = new Set();
      for (const b of seg.bloques) {
        if (typeof b.tx === 'number' && b.tx >= 0) idxs.add(b.tx & 0x0fff);
      }
      let guard = 0;
      while (idxs.has(seg.proxIdxDesc & 0x0fff) && guard++ < 4096) {
        seg.proxIdxDesc = (seg.proxIdxDesc + 1) & 0x0fff;
      }
      // si el cursor ya alcanzó todo lo recibido, los huecos viejos se
      // rellenaron — limpiar la marca para que la nota pueda persistirse
      if (!this._segTieneHuecos(seg)) seg.huecos = false;
    }

    // Reintento diferido de una bajada fallida: el trozo se vuelve a pedir
    // por otra conexión hasta que llegue (o el segmento se cierre/oiga).
    _programarRetryTramo(seg, ms) {
      if (!seg || seg._tramoRetryT) return;
      seg._tramoRetryT = setTimeout(() => {
        seg._tramoRetryT = null;
        // se sigue re-pidiendo aunque ya esté "reproducida": el audio que
        // llegue tarde reabre la frase en _insertarBloque y suena completo
        if (!seg.saltado && this._vozSegs.get(seg.seq) === seg) {
          this._bajarTramos(seg);
        }
      }, ms || 1500);
    }

    // Descarga por HTTP la racha contigua de tramas del segmento desde
    // proxIdxDesc (modelo pull): cada petición es una conexión independiente
    // — una descarga atascada no frena a las demás y el audio jamás se
    // reproduce desordenado: si llega el trozo 3 antes que el 2, el 3 espera.
    async _bajarTramos(seg) {
      if (!seg || seg.pseudo || seg.seq <= 0 || seg._tramoBusy) return;
      if (!window.S || !window.S.sala) return;
      this._programarFeedOn(); // mantiene vivo el sondeo aunque aún no haya audio
      seg._tramoBusy = true;
      seg._ultTramoT = performance.now();
      const ctrl = new AbortController();
      const ctrlT = setTimeout(() => { try { ctrl.abort(); } catch {} }, 9000);
      try {
        const desde = seg.proxIdxDesc || 0;
        const r = await this._fetchAuth(
          `/api/salas/${encodeURIComponent(window.S.sala)}/audio/${seg.seq}/tramos?desde=${desde}`,
          { signal: ctrl.signal });
        if (!r.ok) {
          if (r.status === 404 && !seg.bloques.length && !seg.completo) {
            seg.completo = true;
            seg.finLocal = true;
            seg.saltado = true;
          } else {
            this._programarRetryTramo(seg, 1500);
          }
          return;
        }
        const u8 = new Uint8Array(await r.arrayBuffer());
        if (u8.length < 8 || u8[0] !== 1) return;
        seg._tramoFails = 0;
        const flags = u8[1];
        const n = (u8[6] << 8) | u8[7];
        let o = 8;
        const frames = [];
        for (let k = 0; k < n && o + 2 <= u8.length; k++) {
          const l = (u8[o] << 8) | u8[o + 1];
          o += 2;
          if (o + l > u8.length) break;
          frames.push(u8.subarray(o, o + l));
          o += l;
        }
        if (frames.length) {
          const nuevos = await this._decodificarFramesSeg(frames, seg);
          let sum = 0, cnt = 0;
          for (const b of nuevos) {
            if (typeof b.tx === 'number' && b.tx >= 0) {
              if (seg.vistos.has(b.tx)) continue;
              seg.vistos.add(b.tx);
            }
            this._insertarBloque(seg, { tx: b.tx, pcm: b.pcm });
            for (let i = 0; i < b.pcm.length; i += 8) { sum += b.pcm[i] * b.pcm[i]; cnt++; }
          }
          // nivel RMS para el marcador de "hablando" (mismo umbral que en vivo)
          if (cnt && Math.sqrt(sum / cnt) > 0.006) {
            this._speakers.set(seg.de, Date.now() + 650);
            this._actualizarSpeakers();
          }
          for (const fr of frames) {
            if (seg.rawBytes < 4194304) {
              seg.raw.push(fr.slice());
              seg.rawBytes += fr.length;
            }
          }
          this._avanzarProxIdx(seg);
          seg.ultRxT = performance.now();
          this._programarFeedOn();
          // Racha llena del servidor: pedir de inmediato lo que sigue
          if (n >= 60) setTimeout(() => this._bajarTramos(seg), 0);
        }
        if (flags & 1) {
          // El servidor ya cerró la frase: queda completa localmente, pero
          // se agenda otra pasada — las piezas rezagadas que rellenen su
          // archivo después llegan igualmente por esa conexión nueva
          seg.completo = true;
          console.log('[voz] tramos', seg.seq, 'cerrada desde', desde,
            'trajeron', n, 'tramas | bloques', seg.bloques.length,
            'alimentado', seg.alimentado);
          this._programarBajadaArchivo(seg); // respaldo: el .seg completo
          if ((seg._tramoCerrReintentos = (seg._tramoCerrReintentos || 0) + 1) < 20) {
            this._programarRetryTramo(seg, 2500);
          }
        } else {
          seg._tramoCerrReintentos = 0;
        }
      } catch {
        // conexión caída o colgada a media descarga: re-pedir por otra —
        // con tope si la frase ya cerró, para no sondear de por vida
        if (seg.completo && (seg._tramoFails = (seg._tramoFails || 0) + 1) > 8) return;
        this._programarRetryTramo(seg, 1200);
      } finally {
        clearTimeout(ctrlT);
        seg._tramoBusy = false;
      }
    }

    // Respaldo post-cierre: solo se baja el .seg COMPLETO si el segmento
    // quedó con huecos reales. Con los tramos confirmados por el servidor
    // el respaldo ciego era una segunda descarga del mismo audio por cada
    // frase — desperdicio puro de datos en el oyente.
    _programarBajadaArchivo(seg) {
      if (!seg || seg._archT || seg.descargado || seg.propio) return;
      seg._archT = setTimeout(() => {
        seg._archT = null;
        if (!seg.saltado && !seg.descargado &&
            this._vozSegs.get(seg.seq) === seg &&
            this._segTieneHuecos(seg)) {
          this._bajarSeg(seg.seq);
        }
      }, 3500);
    }

    // ¿Quedaron piezas sin rellenar? Se compara el cursor contiguo de
    // descarga (proxIdxDesc) con la trama más alta recibida: si hay
    // bloques más allá del cursor, falta al menos una pieza intermedia.
    // Si no llegó ninguna trama y la frase cerró, el audio entero falta.
    _segTieneHuecos(seg) {
      if (!seg || seg.descargado) return false;
      let maxIdx = -1;
      for (const b of seg.bloques) {
        if (typeof b.tx === 'number' && b.tx >= 0) {
          const i = b.tx & 0x0fff;
          if (maxIdx < 0 || ((i - maxIdx) & 0x0fff) < 2048) maxIdx = i;
        }
      }
      if (maxIdx >= 0) {
        const d = (maxIdx - (seg.proxIdxDesc || 0)) & 0x0fff;
        return d > 0 && d < 2048;
      }
      return seg.completo || !!seg.huecos;
    }

    // Tras una reconexión: pide al servidor el manifiesto de segmentos que
    // se perdieron durante el corte y los descarga en orden
    async _rellenarHuecos(hasta) {
      const sala = (window.S && window.S.sala) || '';
      if (!sala) return;
      try {
        // ventana con solape: no solo lo nuevo — también repara frases
        // abiertas en local cuyo seg_fin se perdió durante el corte.
        // Sin g= : el servidor filtra por el grupo del token — el mismo
        // que usa para los eventos WS, siempre consistente (un g= que no
        // coincide devolvía manifiesto vacío y las notas se borraban como
        // fantasmas)
        const r = await this._fetchAuth(
          `/api/salas/${encodeURIComponent(sala)}/audio?desde=${Math.max(0, this._ultimoSeg - 40)}`);
        if (!r.ok) return;
        const man = await r.json();
        const vivos = new Set(); // seq que el servidor conoce (cerradas o abiertas)
        const base = this._baseSeg || 0;
        const miId = this.localParticipant.identity;
        for (const meta of man.segmentos || []) {
          vivos.add(meta.seq);
          // las mías también se bajan: _vozSegNuevo las marca 'propio' —
          // no entran a la cola en vivo, pero quedan guardadas en el chat
          const seg = this._vozSegs.get(meta.seq);
          if (seg) {
            // Ya existía en mi sesión: actualizar su cierre y rellenar si tuvo huecos
            this._vozSegNuevo(meta.seq, meta.de, meta.nombre, false, meta);
            // Se baja aunque ya esté reproducida: completa el archivo local
            // (IndexedDB) y el _feedVoz jamás repite un reproducido
            if (!seg.descargado && (seg.huecos || !seg.bloques.length)) {
              this._bajarSeg(meta.seq);
            }
          } else if (meta.seq > base) {
            // Frase nueva ocurrida después de que entré y perdida durante el corte
            const ns = this._vozSegNuevo(meta.seq, meta.de, meta.nombre, false, meta);
            // El audio recuperado por manifiesto también deja su nota en el
            // chat: sin este evento suena pero jamás aparece en el historial
            this.emit('seg_ini', this._segMeta(ns));
            this._bajarSeg(meta.seq);
          }
        }
        if (man.abierto && man.abierto.de !== miId) {
          vivos.add(man.abierto.seq);
          if (!this._vozSegs.get(man.abierto.seq) && man.abierto.seq > base) {
            const ns = this._vozSegNuevo(man.abierto.seq, man.abierto.de, man.abierto.nombre, true, man.abierto);
            this.emit('seg_ini', this._segMeta(ns));
            this._bajarSeg(man.abierto.seq);
          }
        }
        // frases abiertas en local que el servidor ya no tiene ni abiertas:
        // su cierre se perdió en el corte — se cierran para destrabar la
        // cola en vivo (si el servidor la tiene cerrada _vozSegNuevo ya la
        // marcó completo+finLocal)
        for (const s of this._vozOrden) {
          if (!s.pseudo && s.seq > 0 && !s.completo && !s.finLocal &&
              !vivos.has(s.seq)) {
            s.completo = true; s.finLocal = true;
            if (this._segPorHablante.get(s.de) === s.seq) this._segPorHablante.delete(s.de);
          }
        }
        this._ultimoSeg = Math.max(this._ultimoSeg, man.ultimo || 0, hasta);
      } catch {}
    }

    // Decodifica las tramas crudas de un segmento (Opus, ADPCM o µ-law) a
    // bloques PCM a la tasa del AudioContext — para backfill y re-escucha
    async _decodificarFramesSeg(frames, seg) {
      const ctx = this._asegurarRxAudioCtx();
      const ctxRate = ctx.sampleRate || 48000;
      const rsPorRate = new Map(); // inRate -> estado de remuestreo
      const rsDe = (sr) => {
        let st = rsPorRate.get(sr);
        if (!st) { st = { has: false, last: 0, phase: 0 }; rsPorRate.set(sr, st); }
        return st;
      };
      const out = [];
      const ops = [];
      // Dedup por tx ENTRE familias: el emisor manda cada trama en Opus y
      // en ADPCM cuando hay oyentes sin Opus, y el .seg/archivo local guarda
      // ambas. Sin seg (re-escuchas de notas descargadas) no había dedup:
      // cada 40 ms se decodificaba dos veces en dos formatos — la
      // "basurita" que se oía también en el historial. La primera variante
      // decodificable de cada tx gana (Opus si hay decoder; si no, ADPCM).
      const txDecod = new Set();
      for (const fr of frames) {
        const rc = fr[0];
        if (rc === 0 || fr.length < 2) continue;
        const tx = fr[1] | (fr[2] << 8);
        if (seg && seg.vistos.has(tx)) continue;
        if (txDecod.has(tx)) continue;
        if (rc >= 10 && rc <= 19) {
          if (!SOPORTE_OPUS_RX || typeof window.AudioDecoder !== 'function') continue;
          txDecod.add(tx);
          ops.push({ tx, fr, esDual: fr.length > 8 && fr[3] === 0xA5, nSub: 1 });
        } else if (rc >= 20 && rc <= 39) {
          const base = rc >= 30 ? rc - 10 : rc;
          const esV2 = fr.length >= 7 && fr[6] === 0x5A;
          const sr = esV2
            ? (base === 21 ? 8000 : (base === 22 ? 12000 : 16000))
            : (base === 21 ? 6000 : (base === 22 ? 8000 : (base === 23 ? 12000 : 16000)));
          const { pcm } = decodificarBloqueADPCM(fr);
          if (pcm.length) {
            txDecod.add(tx);
            out.push({ tx, pcm: remuestrearA(rsDe(sr), pcm, sr, ctxRate) });
          }
        } else if (rc === 1 || rc === 2) {
          const sr = rc === 1 ? 8000 : 12000;
          const pcm = new Float32Array(fr.length - 1);
          for (let i = 1; i < fr.length; i++) pcm[i - 1] = ulawDecodeTable[fr[i]];
          txDecod.add(tx);
          out.push({ tx, pcm: remuestrearA(rsDe(sr), pcm, sr, ctxRate) });
        }
      }
      if (ops.length && SOPORTE_OPUS_RX && typeof window.AudioDecoder === 'function') {
        const outs = [];
        try {
          const dec = new window.AudioDecoder({
            output: (ad) => { outs.push(extraerFloat32DeAudioData(ad)); ad.close(); },
            error: () => { outs.push(new Float32Array(960)); },
          });
          dec.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });
          let ts = 0;
          for (const o of ops) {
            const fr = o.fr;
            o.nSub = 0; // cuenta REAL de chunks decodificados de este paquete
            if (o.esDual) {
              const len1 = fr[4] | (fr[5] << 8);
              const off1 = 6;
              if (off1 + len1 <= fr.length && len1 > 0) {
                dec.decode(new window.EncodedAudioChunk({
                  type: 'key', timestamp: ts, duration: 20000,
                  data: fr.subarray(off1, off1 + len1),
                }));
                ts += 20000;
                o.nSub++;
              }
              const off2 = off1 + len1;
              if (off2 + 2 <= fr.length) {
                const len2 = fr[off2] | (fr[off2 + 1] << 8);
                if (off2 + 2 + len2 <= fr.length && len2 > 0) {
                  dec.decode(new window.EncodedAudioChunk({
                    type: 'key', timestamp: ts, duration: 20000,
                    data: fr.subarray(off2 + 2, off2 + 2 + len2),
                  }));
                  ts += 20000;
                  o.nSub++;
                }
              }
            } else {
              dec.decode(new window.EncodedAudioChunk({
                type: 'key', timestamp: ts, duration: 20000, data: fr.subarray(3),
              }));
              ts += 20000;
              o.nSub++;
            }
          }
          await dec.flush().catch(() => {});
          try { dec.close(); } catch {}
        } catch {}
        let oi = 0;
        for (const o of ops) {
          const partes = outs.slice(oi, oi + o.nSub);
          oi += o.nSub;
          if (!partes.length) continue;
          const total = partes.reduce((a, p) => a + p.length, 0);
          // Un paquete dual que solo trajo una sub-trama (20 ms) se rellena
          // a 40 ms: si entra corto, toda la frase siguiente queda corrida
          const pcm = new Float32Array(o.esDual ? Math.max(1920, total) : total);
          let w = 0;
          for (const p of partes) { pcm.set(p, w); w += p.length; }
          out.push({ tx: o.tx, pcm: remuestrearA(rsDe(48000), pcm, 48000, ctxRate) });
        }
      }
      return out;
    }

    // Vacía la salida sin cortar el nodo: lo ya encolado deja de sonar al
    // instante (interrumpir una nota o el audio en vivo con otra nota)
    _vaciarPipeVoz() {
      const pipe = this._vozPipe;
      this._vozBufMs = 0;
      if (!pipe) return;
      if (pipe.worklet) {
        try { pipe.worklet.port.postMessage({ t: 'limpiar' }); } catch {}
      } else {
        pipe.available = 0;
        pipe.readPosF = pipe.writePos;
        pipe.playing = false;
        pipe.eosPending = false;
        pipe.waitSamples = 0;
        pipe.readRate = 1.0;
      }
    }

    // ---------- re-escucha de notas de voz ----------
    _encolarReplay(seq, bloques) {
      if (!bloques.length) return false;
      // Una misma nota jamás entra dos veces: si ya está sonando o encolada,
      // se da por encolada y no se duplica la reproducción
      if ((this._replayProg[0] && this._replayProg[0].seq === seq) ||
          this._replayQ.some((r) => r.seq === seq)) return true;
      // La nueva nota interrumpe de inmediato: se descarta lo que sonaba
      // (otra re-escucha o el audio vivo encolado). Al terminar, el vivo
      // continúa por donde va su retraso — lo perdido queda en el historial.
      if (this._replayProg.length || this._replayQ.length || this._vozBufMs > 60) {
        while (this._replayProg.length) this.emit('seg_replay_fin', this._replayProg.shift().seq);
        this._replayQ.length = 0;
        this._vaciarPipeVoz();
      }
      this._replayPendMs = 0; // contadores SIEMPRE a cero: la cola anterior
      this._replayPlayedMs = 0; // pudo terminar sola dejando restos heredados
      this._replayPausas.delete(seq); // re-escucharla desde 0 olvida su pausa
      const rate = (this._vozPipe && this._vozPipe.ctxRate) || this._vozRate;
      const msTotal = bloques.reduce((m, b) => m + (b.pcm.length / rate) * 1000, 0);
      this._replaySrc = { seq, bloques }; // fuente para pausar/reanudar
      this._replayQ.push({ seq, bloques, alimentado: 0, msTotal });
      this._replayProg.push({ seq, msTotal, remMs: msTotal, baseMs: 0, finMs: msTotal });
      this._programarFeedOn();
      return true;
    }

    // Pisar de nuevo la nota que está sonando la PAUSA (no la reinicia):
    // se guarda la posición ya escuchada y se vacía el reproductor
    pausarReplay(seq) {
      const rp = this._replayProg && this._replayProg[0];
      if (!rp || rp.seq !== seq) return false;
      const posMs = Math.min(rp.msTotal,
        (rp.baseMs || 0) + Math.max(0, this._replayPlayedMs - (rp.finMs - rp.remMs)));
      const enCola = this._replayQ.length && this._replayQ[0].seq === seq
        ? this._replayQ[0] : null;
      const bloques = (this._replaySrc && this._replaySrc.seq === seq ? this._replaySrc.bloques
        : enCola ? enCola.bloques
        : (this._vozSegs.get(seq) && this._vozSegs.get(seq).bloques) || null);
      if (!bloques || !bloques.length) return false;
      // la pausa sobrevive a otras notas: queda guardada por seq hasta
      // reanudarla, re-escucharla desde el inicio o saltar al presente
      this._replayPausas.set(seq, { seq, posMs, msTotal: rp.msTotal, bloques });
      this._replayQ.length = 0;
      this._replayProg.length = 0;
      this._replayPendMs = 0;
      this._replayPlayedMs = 0;
      this._vaciarPipeVoz();
      return true;
    }

    // ⏹ de una nota: olvida su pausa y, si es la que está sonando, corta
    // la salida al instante. El fin avisado deja el botón en ▶ y la
    // próxima escucha empieza desde el principio
    detenerReplay(seq) {
      this._replayPausas.delete(seq);
      const rp = this._replayProg && this._replayProg[0];
      if (rp && rp.seq === seq) {
        this._replayQ.length = 0;
        this._replayProg.length = 0;
        this._replayPendMs = 0;
        this._replayPlayedMs = 0;
        this._vaciarPipeVoz();
      }
      this.emit('seg_replay_fin', seq);
    }

    // Reanuda la nota pausada desde donde quedó (salta los bloques ya
    // escuchados según la posición guardada; precisión de ~40 ms)
    reanudarReplay(seq) {
      const p = this._replayPausas.get(seq);
      if (!p) return false;
      // Reanudar interrumpe igual que tocar otra nota: si algo suena,
      // se descarta y la pausada entra ya (no se encola detrás)
      if (this._replayProg.length || this._replayQ.length || this._vozBufMs > 60) {
        while (this._replayProg.length) this.emit('seg_replay_fin', this._replayProg.shift().seq);
        this._replayQ.length = 0;
        this._replayPendMs = 0;
        this._replayPlayedMs = 0;
        this._vaciarPipeVoz();
      }
      const rate = (this._vozPipe && this._vozPipe.ctxRate) || this._vozRate;
      let ms = 0, i = 0;
      while (i < p.bloques.length &&
             ms + (p.bloques[i].pcm.length / rate) * 1000 <= p.posMs) {
        ms += (p.bloques[i].pcm.length / rate) * 1000;
        i++;
      }
      const resto = p.bloques.slice(i);
      if (!resto.length) { // estaba pausada al filo del final: se da por oída
        this.emit('seg_replay_fin', p.seq);
        return true;
      }
      const remMs = p.msTotal - ms;
      this._replayPausas.delete(p.seq); // ya suena: la pausa quedó consumida
      this._replayQ.push({ seq: p.seq, bloques: resto, alimentado: 0, msTotal: remMs });
      this._replayProg.push({ seq: p.seq, msTotal: p.msTotal, remMs, baseMs: ms, finMs: remMs });
      this._programarFeedOn();
      return true;
    }

    reproducirSeg(seq) {
      const seg = this._vozSegs.get(seq);
      if (!seg || !seg.bloques.length) return false;
      // Si en vivo llegaron tramas con huecos y aún no se descargó el archivo
      // completo del servidor, devolver false para que el llamador descargue
      // el .seg íntegro del servidor en vez de reproducir la copia rota
      if (seg.huecos && !seg.descargado) return false;
      return this._encolarReplay(seq, seg.bloques.slice());
    }

    async reproducirRaw(raw, seq) {
      if (!raw || !raw.length) return false;
      const frames = raw.map((b) => (b instanceof Uint8Array ? b : new Uint8Array(b)));
      const bl = await this._decodificarFramesSeg(frames, null);
      return this._encolarReplay(seq || ('r' + Date.now()), bl);
    }

    // Re-escucha directa de un archivo .seg del servidor (formato CSEG)
    async reproducirArchivo(buf, seq) {
      const parsed = parsearArchivoSeg(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
      if (!parsed || !parsed.frames.length) return false;
      const bl = await this._decodificarFramesSeg(parsed.frames, null);
      const sq = seq || parsed.sg.seq;
      const seg = sq ? this._vozSegs.get(sq) : null;
      if (seg && bl.length) {
        seg.bloques = bl.slice();
        seg.raw = parsed.frames.map(f => f.slice());
        seg.rawBytes = seg.raw.reduce((a, u) => a + u.length, 0);
        seg.descargado = true;
        seg.huecos = false;
      }
      return this._encolarReplay(sq || ('r' + Date.now()), bl);
    }

    // Expone el parser CSEG: la app guarda en IndexedDB la nota descargada
    // bajo demanda para que vuelva a sonar sin conexión
    analizarArchivoSeg(buf) {
      return parsearArchivoSeg(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
    }

    datosSeg(seq) {
      const s = this._vozSegs.get(seq);
      return s ? {
        seq: s.seq, de: s.de, nombre: s.nombre, durMs: s.durMs,
        inicio: s.inicio, interrumpida: s.interrumpida, raw: s.raw,
        huecos: !!s.huecos, descargado: !!s.descargado,
      } : null;
    }

    // PCM decodificado de un segmento (para exportar notas a un WAV):
    // RAM → bloques ya decodificados; si no, decodifica sus tramas crudas
    async bloquesDeSeg(seq) {
      const seg = this._vozSegs.get(seq);
      if (!seg) return null;
      if (seg.bloques && seg.bloques.length) return seg.bloques.slice();
      if (seg.raw && seg.raw.length)
        return this._decodificarFramesSeg(seg.raw.map(b => b instanceof Uint8Array ? b : new Uint8Array(b)), null);
      return null;
    }

    async bloquesDeRaw(raw) {
      if (!raw || !raw.length) return null;
      const frames = raw.map(b => b instanceof Uint8Array ? b : new Uint8Array(b));
      return this._decodificarFramesSeg(frames, null);
    }

    async bloquesDeArchivo(buf) {
      const parsed = parsearArchivoSeg(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
      if (!parsed || !parsed.frames.length) return null;
      return this._decodificarFramesSeg(parsed.frames, null);
    }

    _enviarEstadoMedia() {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
      try {
        this._ws.send(JSON.stringify({
          t: 'estado_media',
          mic: this.localParticipant.isMicrophoneEnabled,
          cam: this.localParticipant.isCameraEnabled,
          pan: this.localParticipant.isScreenShareEnabled,
          opusRx: SOPORTE_OPUS_RX,
        }));
      } catch {}
    }

    // Evalúa en tiempo real la conexión del usuario (RTT, Jitter, cola del WebSocket
    // y API NetworkInformation del celular) y emite ConnectionQualityChanged para
    // auto-ajustar entre ~10 kbps (2G/lenta), ~18 kbps (normal) y ~28 kbps (buena).
    _evaluarCalidadRed(rttMedido) {
      if (typeof rttMedido === 'number' && rttMedido > 0 && rttMedido < 15000) {
        const delta = Math.abs(rttMedido - this._rttMs);
        this._jitterMs = this._jitterMs * 0.75 + delta * 0.25;
        this._rttMs = this._rttMs * 0.7 + rttMedido * 0.3;
      }

      const navConn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      const effType = navConn && navConn.effectiveType ? String(navConn.effectiveType) : '';
      const downlink = navConn && typeof navConn.downlink === 'number' ? navConn.downlink : 10;
      const saveData = !!(navConn && navConn.saveData);
      const buf = (this._ws && this._ws.bufferedAmount) || 0;

      let candidata = ConnectionQuality.Excellent;
      if (
        saveData ||
        effType === 'slow-2g' ||
        effType === '2g' ||
        downlink < 0.35 ||
        this._rttMs > 340 ||
        this._jitterMs > 100 ||
        buf > 16384
      ) {
        candidata = ConnectionQuality.Poor;
      } else if (
        effType === '3g' ||
        downlink < 1.4 ||
        this._rttMs > 145 ||
        this._jitterMs > 40 ||
        buf > 4096
      ) {
        candidata = ConnectionQuality.Good;
      }

      const orden = {
        [ConnectionQuality.Poor]: 1,
        [ConnectionQuality.Good]: 2,
        [ConnectionQuality.Excellent]: 3,
      };

      if (orden[candidata] < orden[this._calidadActual]) {
        // Si la red empeora, bajar de inmediato para que la voz jamás se corte
        this._buenasSeguidas = 0;
        this._calidadActual = candidata;
        this.emit(RoomEvent.ConnectionQualityChanged, this._calidadActual, this.localParticipant);
      } else if (orden[candidata] > orden[this._calidadActual]) {
        // Si la red mejora, esperar 3 mediciones estables (~9 s) antes de subir el bitrate
        this._buenasSeguidas++;
        if (this._buenasSeguidas >= 3) {
          this._buenasSeguidas = 0;
          this._calidadActual = candidata;
          this.emit(RoomEvent.ConnectionQualityChanged, this._calidadActual, this.localParticipant);
        }
      } else {
        this._buenasSeguidas = 0;
      }
    }

    _iniciarMonitorRed() {
      if (this._pingTimer) clearInterval(this._pingTimer);
      this._lastRxAt = performance.now();
      this._evaluarCalidadRed();
      this.emit(RoomEvent.ConnectionQualityChanged, this._calidadActual, this.localParticipant);

      const enviarPing = () => {
        if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
        const now = performance.now();
        // En datos móviles las ráfagas pueden tardar varios segundos: NO
        // matar el socket por bufferedAmount ni a los 4,5 s (eso tiraba las
        // tramas en vuelo y causaba reconexiones en bucle). Solo reemplazar
        // si el socket lleva >20 s completamente muerto sin recibir nada.
        if ((now - (this._lastRxAt || now)) > 20000) {
          this._lastRxAt = now;
          if (typeof this._reemplazarSocketCongelado === 'function') {
            this._reemplazarSocketCongelado();
            return;
          }
        }
        if (this._ws.bufferedAmount > 32768) {
          this._evaluarCalidadRed(420);
        }
        try {
          this._ws.send(JSON.stringify({ t: 'ping_net', ts: Math.round(now) }));
        } catch {}
      };
      setTimeout(enviarPing, 500);
      this._pingTimer = setInterval(enviarPing, 2000);

      const navConn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (navConn && typeof navConn.addEventListener === 'function') {
        this._onNetChange = () => {
          this._evaluarCalidadRed();
        };
        navConn.addEventListener('change', this._onNetChange);
      }
    }

    async connect(baseUrl, token) {
      await promesaDeteccionOpus;
      this._closedByClient = false;
      if (!this._connSid) {
        this._connSid = Math.random().toString(36).slice(2, 10);
      }
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
      try {
        const ctx = this._asegurarRxAudioCtx();
        await asegurarWorkletEnCtx(ctx);
      } catch {}

      // Decodificar identidad y nombre del token (base64url antes del punto)
      try {
        const b64 = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
        const claims = JSON.parse(atob(b64));
        this.localParticipant.identity = claims.sub || '';
        this.localParticipant.name = claims.name || claims.sub || '';
        this._canMic = !!claims.mic;
        this._canCam = !!claims.cam;
        this._canPan = !!claims.pan;
      } catch {}

      const sala = (window.S && window.S.sala) || new URLSearchParams(location.search).get('sala') || '';
      const wsBase = (baseUrl || location.origin).replace(/^http/, 'ws').replace(/\/$/, '');
      const wsUrl = `${wsBase}/api/salas/${encodeURIComponent(sala)}/media?token=${encodeURIComponent(token)}&opus=${SOPORTE_OPUS_RX ? 1 : 0}&sid=${encodeURIComponent(this._connSid)}`;
      this._wsUrl = wsUrl;

      const programarReconexionInterna = (intento) => {
        if (this._closedByClient || this._reconnectTimer) return;
        const espera = Math.min(3500, 600 + intento * 600);
        this._reconnectTimer = setTimeout(() => {
          this._reconnectTimer = null;
          if (this._closedByClient) return;
          abrirSocket(intento + 1, null, null, false);
        }, espera);
      };

      const abrirSocket = (intento, resolveInicial, rejectInicial, esReemplazoVivo) => {
        if (this._closedByClient) return;
        let conectado = false;
        let ws;
        try {
          ws = new WebSocket(wsUrl);
        } catch (err) {
          if (resolveInicial) {
            if (intento < 4) {
              setTimeout(() => abrirSocket(intento + 1, resolveInicial, rejectInicial, false), 600);
            } else {
              rejectInicial(err);
            }
          } else if (!esReemplazoVivo) {
            programarReconexionInterna(intento);
          }
          return;
        }
        ws.binaryType = 'arraybuffer';
        if (!esReemplazoVivo) {
          this._ws = ws;
        }

        const timeout = setTimeout(() => {
          if (!conectado) {
            try { ws.close(); } catch {}
          }
        }, 7000);

        ws.onopen = () => {
          if (this._closedByClient) {
            try { ws.close(); } catch {}
            return;
          }
          conectado = true;
          clearTimeout(timeout);
          const viejo = this._ws;
          this._ws = ws;
          this._lastRxAt = performance.now();
          if (viejo && viejo !== ws) {
            try { viejo.close(1000, 'replaced'); } catch {}
          }
          if (!this._speakerTimer) {
            this._speakerTimer = setInterval(() => this._actualizarSpeakers(), 300);
          }
          this._programarFeedOn();
          this._iniciarMonitorRed();
          this._enviarEstadoMedia();
          if (window.S && typeof window.S.grupoActual === 'number' && window.S.grupoActual > 0) {
            try { ws.send(JSON.stringify({ t: 'cambiar_grupo', grupo: window.S.grupoActual })); } catch {}
          }
          // Tras una reconexión el estado LOCAL del PTT manda sobre el del
          // servidor: si sigo pisado reclamo el piso; si ya solté (dedo
          // levantado, sin candado, VAD callado) se lo declaro SUELTO para
          // que cierre el piso y la frase que pueda conservar de antes
          if (this._quieroPiso) {
            this._enviarJson({ t: 'piso_tomar', aid: this._pisoAidAct || this._vozAid || 0 });
            setTimeout(() => this._drenarTx(), 350);
          } else {
            this._enviarJson({ t: 'piso_soltar', aid: this._ultAidSuelto || this._pisoAidAct || 0 });
            this._programarFlushTx();
          }
          // Voz propia en vuelo cuando murió el socket anterior: la reenvío
          // — el servidor la deduplica por tx y la inserta en su hueco
          setTimeout(() => this._reenvioVozPendiente(), 500);
          this.emit(RoomEvent.ConnectionStateChanged, 'connected');
          // reconexión interna del socket de medios: la app resincroniza el
          // historial (los seg_ini/seg_fin perdidos en el corte llegan por
          // el manifiesto — igual que los audios faltantes)
          if (!resolveInicial) this.emit('media_reconectada');
          if (resolveInicial) resolveInicial();
        };

        ws.onerror = () => {};

        ws.onmessage = (ev) => {
          if (this._ws !== ws) return;
          this._lastRxAt = performance.now();
          if (typeof ev.data === 'string') {
            this._manejarTexto(ev.data);
          } else if (ev.data instanceof ArrayBuffer) {
            this._manejarBinario(new Uint8Array(ev.data));
          }
        };

        ws.onclose = (ev) => {
          clearTimeout(timeout);
          // Si este socket ya fue reemplazado por otro nuevo (Make-Before-Break), ignorar su cierre
          if (this._ws !== ws) return;
          this._ws = null;
          if (this._closedByClient) return;

          if (ev.code === 4002 || ev.reason === 'DUPLICATE_IDENTITY') {
            this.disconnectReason = DisconnectReason.DUPLICATE_IDENTITY;
            this.emit(RoomEvent.Disconnected, this.disconnectReason);
            return;
          }
          if (ev.code === 4003) {
            this.disconnectReason = DisconnectReason.PARTICIPANT_REMOVED;
            this.emit(RoomEvent.Disconnected, this.disconnectReason);
            return;
          }

          if (!conectado && resolveInicial) {
            if (intento < 4) {
              setTimeout(() => abrirSocket(intento + 1, resolveInicial, rejectInicial, false), 650);
            } else {
              rejectInicial(new Error('No se pudo abrir la conexión WebSocket HTTPS'));
            }
            return;
          }

          programarReconexionInterna(1);
        };
      };

      this._reemplazarSocketCongelado = () => {
        if (this._closedByClient || this._reconnectTimer) return;
        abrirSocket(1, null, null, true);
      };

      await new Promise((resolve, reject) => {
        abrirSocket(0, resolve, reject, false);
      });
    }

    async disconnect() {
      this._closedByClient = true;
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
      if (this.localParticipant._micCleanup) this.localParticipant._micCleanup();
      if (this.localParticipant._camCleanup) this.localParticipant._camCleanup();
      if (this.localParticipant._scrCleanup) this.localParticipant._scrCleanup();
      if (this.localParticipant._ashCleanup) this.localParticipant._ashCleanup();
      if (this._speakerTimer) {
        clearInterval(this._speakerTimer);
        this._speakerTimer = null;
      }
      if (this._pingTimer) {
        clearInterval(this._pingTimer);
        this._pingTimer = null;
      }
      if (this._feedT) { clearInterval(this._feedT); this._feedT = null; }
      if (this._pisoHoldT) { clearInterval(this._pisoHoldT); this._pisoHoldT = null; }
      if (this._txFlushT) { clearTimeout(this._txFlushT); this._txFlushT = null; }
      this._txCola.length = 0;
      this._txBytes = 0;
      this._ctrlCola.length = 0;
      this._resetVozTxPend();
      this._quieroPiso = false;
      this._tengoPiso = false;
      this._pisoDe = '';
      if (this._vozPipe) {
        const vp = this._vozPipe;
        this._vozPipe = null;
        try { if (vp.worklet) vp.worklet.disconnect(); } catch {}
        try { if (vp.proc) vp.proc.disconnect(); } catch {}
        try { if (vp.gainNode) vp.gainNode.disconnect(); } catch {}
      }
      this._vozSegs.clear();
      this._vozOrden.length = 0;
      this._segPorHablante.clear();
      this._vozBase = false;
      this._ultimoSeg = 0;
      this._replayQ.length = 0;
      this._fetchSegs.clear();
      this._vozBufMs = 0;
      this._jitMs = 400;
      this._jitBumpT = 0;
      this._jitUltimoCorte = 0;
      this._starveDesde = 0;
      this._retrasoAviso = 0;
      const navConn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (navConn && this._onNetChange && typeof navConn.removeEventListener === 'function') {
        navConn.removeEventListener('change', this._onNetChange);
        this._onNetChange = null;
      }
      for (const sid of [...this._rxPipelines.keys()]) {
        this._limpiarPipelineRemoto(sid);
      }
      if (this._ws) {
        const ws = this._ws;
        this._ws = null;
        try { ws.close(1000, 'client disconnect'); } catch {}
      }
      if (this._rxAudioCtx) {
        if (window.S && window.S.salidaCtx === this._rxAudioCtx) {
          window.S.salidaCtx = null;
        }
        try { this._rxAudioCtx.close(); } catch {}
        this._rxAudioCtx = null;
      }
    }

    _manejarTexto(raw) {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      switch (m.t) {
        case 'pong_net':
          if (typeof m.ts === 'number') {
            const rtt = performance.now() - m.ts;
            this._evaluarCalidadRed(rtt);
          }
          break;

        case 'bienvenida':
          this.localParticipant.identity = m.identidad || this.localParticipant.identity;
          this._canMic = !!m.canMic;
          this._canCam = !!m.canCam;
          this._canPan = !!m.canPan;
          if (typeof m.ultimoSeg === 'number') {
            if (!this._vozBase) {
              // Primera conexión: la base del historial es el último segmento
              // cerrado — el oyente entra "al presente" (el pasado está en el
              // historial, no se descarga solo)
              this._vozBase = true;
              this._baseSeg = m.ultimoSeg;
              this._ultimoSeg = Math.max(this._ultimoSeg, m.ultimoSeg);
            } else if (m.ultimoSeg > this._ultimoSeg) {
              // Reconexión tras micro-corte: descargar las frases perdidas
              this._rellenarHuecos(m.ultimoSeg);
            }
          }
          break;

        case 'seg_ini': {
          // Aviso de que alguien empezó una frase (segmento abierto)
          const de = m.de || '';
          if (de === this.localParticipant.identity) {
            // Mi propia voz no se encola ni se reproduce, pero la UI sí
            // muestra la nota "grabando" en el historial al instante
            this.emit('seg_ini', {
              seq: m.seq, de, nombre: m.nombre || de,
              inicio: Date.now(), durMs: 0, abierto: true,
            });
            break;
          }
          const cur = this._segPorHablante.get(de);
          // Como el piso es exclusivo (1 hablante a la vez), al iniciar una
          // frase nueva cualquier frase anterior que haya quedado abierta en
          // local se da por terminada para no tapar la voz nueva
          for (const ant of this._vozOrden) {
            if (!ant.completo && !ant.finLocal && ant.seq !== cur) {
              ant.finLocal = true;
              // no darla por muerta si aún hay una descarga en vuelo: en
              // red lenta su primer trozo puede tardar más que el piso
              if (!ant.bloques.length && !ant.bajando && !ant._tramoBusy)
                ant.saltado = true;
            }
          }
          let seg;
          if (cur != null && cur < 0) {
            // Ya llegaban tramas en vivo con seq pseudo: re-etiquetar al real
            seg = this._vozSegs.get(cur);
            this._vozSegs.delete(cur);
            const oi = this._vozOrden.indexOf(seg);
            if (oi >= 0) this._vozOrden.splice(oi, 1);
            seg.seq = m.seq;
            seg.pseudo = false;
            if (m.nombre) seg.nombre = m.nombre;
            this._vozSegs.set(m.seq, seg);
            let i = this._vozOrden.length;
            while (i > 0 && (this._vozOrden[i - 1].pseudo ? Infinity : this._vozOrden[i - 1].seq) > m.seq) i--;
            this._vozOrden.splice(i, 0, seg);
            this._segPorHablante.set(de, m.seq);
          } else {
            seg = this._vozSegNuevo(m.seq, de, m.nombre, true);
          }
          this._ultimoSeg = Math.max(this._ultimoSeg, m.seq);
          // Opción "ir al presente automático": si la frase nueva empieza y
          // llevamos mucho atraso, saltar directo al audio en vivo
          if (this._autoPresente && this._retrasoMs() > 5000) {
            this.saltarAlPresente();
          }
          // Empezar a bajar la frase por HTTP de inmediato: el sondeo
          // periódico y los avisos 'chunk' la mantienen al día en orden
          this._bajarTramos(seg);
          this.emit('seg_ini', this._segMeta(seg));
          break;
        }

        case 'seg_fin': {
          // La frase terminó (EOS): el segmento es una nota de voz cerrada
          if (m.de === this.localParticipant.identity) {
            this._ultimoSeg = Math.max(this._ultimoSeg, m.seq || 0);
            // Mi propia frase no suena en vivo, pero sí se queda guardada
            // en el chat igual que la de los demás: bajar su .seg para
            // archivarla en IndexedDB (datosSeg la expone a idbGuardarSeg)
            if (m.seq) this._bajarSeg(m.seq);
            this.emit('seg_fin', {
              seq: m.seq, de: m.de, nombre: m.nombre || m.de,
              durMs: m.durMs || 0, inicio: Date.now() - (m.durMs || 0),
              interrumpida: !!m.interrumpida, abierto: false,
            });
            break;
          }
          let seg = this._vozSegs.get(m.seq);
          if (seg) {
            seg.completo = true;
            seg.abierto = false;
            seg.finLocal = true;
            if (m.durMs) seg.durMs = m.durMs;
            if (m.interrumpida) seg.interrumpida = true;
            if (m.nombre) seg.nombre = m.nombre;
            if (this._segPorHablante.get(m.de) === m.seq) {
              this._segPorHablante.delete(m.de);
            }
            console.log('[voz] seg_fin', m.seq, 'de', m.de,
              'alimentado', seg.alimentado, '/', seg.bloques.length,
              'reproducido', seg.reproducido, 'saltado', seg.saltado);
            // Cola final de la frase + huecos: la racha contigua primero;
            // el .seg completo unos segundos después, como respaldo — lo
            // que aún viajaba cuando llegó seg_fin llega igual y suena.
            // Solo la primera vez: el servidor re-emite seg_fin en cada
            // resincronización y duplicar el sondeo no aporta nada.
            if (!seg._finVisto) {
              seg._finVisto = true;
              this._bajarTramos(seg);
              this._programarBajadaArchivo(seg);
              if (seg.huecos && !seg.descargado) this._bajarSeg(m.seq);
            }
          } else {
            // Nunca vimos la frase (corte largo): crearla y descargarla —
            // salvo si es mía: mi propia voz no se reproduce ni se descarga
            seg = this._vozSegNuevo(m.seq, m.de, m.nombre, false, m);
            if (m.de !== this.localParticipant.identity) this._bajarSeg(m.seq);
          }
          this._ultimoSeg = Math.max(this._ultimoSeg, m.seq);
          this.emit('seg_fin', this._segMeta(seg));
          break;
        }

        case 'chunk': {
          // El servidor archivó tramas nuevas de un segmento: bajar la racha
          // contigua por HTTP (cada descarga es una conexión independiente)
          const seq = Number(m.seq) || 0;
          const de = m.de || '';
          if (!seq || de === this.localParticipant.identity) break;
          let seg = this._vozSegs.get(seq);
          if (!seg) seg = this._vozSegNuevo(seq, de, m.nombre || de, !m.cerr, m);
          if (m.cerr) { seg.completo = true; this._programarBajadaArchivo(seg); }
          if (m.nombre) seg.nombre = m.nombre;
          this._bajarTramos(seg);
          break;
        }

        case 'piso_ok':
          // Si este piso_ok corresponde a un aid que ya solté localmente,
          // ignorarlo y confirmar que ese aid está suelto
          if (!this._quieroPiso || (m.aid && m.aid === this._ultAidSuelto && m.aid !== this._pisoAidAct)) {
            this._tengoPiso = false;
            this._enviarJson({ t: 'piso_soltar', aid: m.aid || this._ultAidSuelto || 0 }, true);
            break;
          }
          this._tengoPiso = true;
          this.emit('piso', { estado: 'mio', aid: m.aid || this._pisoAidAct || 0 });
          break;

        case 'piso_estado':
          // El servidor avisa al instante a todos los clientes quién tiene el
          // PTT (o "" cuando se liberó): los oyentes siguen escuchando el
          // audio en cola, pero su PTT queda desbloqueado de inmediato para
          // que puedan pisar e interrumpir sin esperar a que termine la cola.
          this._pisoDe = m.piso || '';
          this.emit('piso_estado', { piso: m.piso || '', nombre: m.nombre || '' });
          break;

        case 'piso_ocupado':
          this._tengoPiso = false;
          this.emit('piso_ocupado', {
            nombre: m.nombre || '', faltan: m.faltan || 0, error: m.error || '',
          });
          break;

        case 'piso_perdido':
          this._tengoPiso = false;
          this.emit('piso_perdido', { por: m.por || '' });
          break;

        case 'falta':
          // El servidor detectó huecos en MI frase archivada: reenvío las
          // tramas que conservo — grabación completa aunque haya cortes
          this._reenviosVoz(m.txs);
          break;

        case 'seg_ack':
          // El servidor ya recibió completo ese audio (aid): suelto su
          // semilla — hasta este punto NUNCA se descartó ni una trama
          this._ackVoz(m.aid);
          break;

        case 'permisos':
          this._canMic = !!m.canMic;
          this._canCam = !!m.canCam;
          this._canPan = !!m.canPan;
          if (!this._canMic) {
            const mp = this.localParticipant.getTrackPublication(TrackSource.Microphone);
            if (mp) {
              if (mp.track) mp.track.stop();
              this.localParticipant.unpublishTrack(mp.track).catch(() => {});
            }
          }
          if (!this._canCam && this.localParticipant.isCameraEnabled) {
            this.localParticipant.setCameraEnabled(false).catch(() => {});
          }
          if (!this._canPan && this.localParticipant.isScreenShareEnabled) {
            this.localParticipant.setScreenShareEnabled(false).catch(() => {});
          }
          this.emit(RoomEvent.ParticipantPermissionsChanged, null, this.localParticipant);
          break;

        case 'forzar_mute':
          if (m.mic) {
            const mp = this.localParticipant.getTrackPublication(TrackSource.Microphone);
            if (mp) {
              if (mp.track) mp.track.stop();
              this.localParticipant.unpublishTrack(mp.track).catch(() => {});
            }
          }
          if (m.cam && this.localParticipant.isCameraEnabled) {
            this.localParticipant.setCameraEnabled(false).catch(() => {});
          }
          break;

        case 'peers':
          if (typeof m.haySinOpus === 'boolean') {
            this._haySinOpus = m.haySinOpus;
          }
          this._sincronizarPeers(m.peers || []);
          break;

        case 'estado_push':
          if (m.d && typeof window.aplicarEstado === 'function') {
            try { window.aplicarEstado(m.d, 'sse'); } catch {}
          }
          break;

        case 'audio_share_meta': {
          const from = m.from;
          if (!from || from === this.localParticipant.identity) break;
          const p = this.remoteParticipants.get(from);
          if (!p) break;
          if (!m.activo) {
            const pub = p.pubs.get(TrackSource.ScreenShareAudio);
            if (pub) {
              this._limpiarPipelineRemoto(pub.trackSid);
              p.pubs.delete(TrackSource.ScreenShareAudio);
              this.emit(RoomEvent.TrackUnsubscribed, pub.track, pub, p);
            }
          } else {
            this._asegurarAudioRemoto(p, TrackSource.ScreenShareAudio, m.nombre || '🎵 Audio');
          }
          break;
        }

        default: {
          // Mensajes de datos de la aplicación (chat, wb, reaccion, aud_vol...)
          const fromId = m.from || '';
          const p = this.remoteParticipants.get(fromId) || {
            identity: fromId,
            name: m.fromName || fromId,
          };
          const bytes = new TextEncoder().encode(raw);
          this.emit(RoomEvent.DataReceived, bytes, p);
          break;
        }
      }
    }

    _sincronizarPeers(lista) {
      const vistos = new Set();
      for (const info of lista) {
        if (!info.identidad) continue;
        if (info.identidad === this.localParticipant.identity) {
          this.localParticipant.name = info.nombre || this.localParticipant.name;
          this._canMic = !!info.canMic;
          this._canCam = !!info.canCam;
          this._canPan = !!info.canPan;
          continue;
        }
        vistos.add(info.identidad);
        let p = this.remoteParticipants.get(info.identidad);
        const esNuevo = !p;
        if (!p) {
          p = new Participant(info.identidad, info.nombre, false, this);
          this.remoteParticipants.set(info.identidad, p);
        } else {
          p.name = info.nombre || p.name;
        }

        // Sincronizar estado de micrófono remoto
        if (info.mic) {
          const pub = this._asegurarAudioRemoto(p, TrackSource.Microphone, 'microfono');
          if (pub.isMuted) {
            pub.isMuted = false;
            this.emit(RoomEvent.TrackUnmuted, pub, p);
          }
        } else {
          const pub = p.pubs.get(TrackSource.Microphone);
          if (pub && !pub.isMuted) {
            pub.isMuted = true;
            this.emit(RoomEvent.TrackMuted, pub, p);
          }
        }

        // Sincronizar estado de cámara remota
        if (!info.cam) {
          const pub = p.pubs.get(TrackSource.Camera);
          if (pub) {
            p.pubs.delete(TrackSource.Camera);
            this.emit(RoomEvent.TrackUnsubscribed, pub.track, pub, p);
          }
        }

        // Sincronizar estado de pantalla remota
        if (!info.pan) {
          const pub = p.pubs.get(TrackSource.ScreenShare);
          if (pub) {
            p.pubs.delete(TrackSource.ScreenShare);
            this.emit(RoomEvent.TrackUnsubscribed, pub.track, pub, p);
          }
        }

        if (esNuevo) {
          this.emit(RoomEvent.ParticipantConnected, p);
        }
      }

      // Quitar participantes que salieron del grupo/sala
      for (const [id, p] of [...this.remoteParticipants.entries()]) {
        if (!vistos.has(id)) {
          for (const pub of p.pubs.values()) {
            this._limpiarPipelineRemoto(pub.trackSid);
            this.emit(RoomEvent.TrackUnsubscribed, pub.track, pub, p);
          }
          p.pubs.clear();
          this.remoteParticipants.delete(id);
          this.emit(RoomEvent.ParticipantDisconnected, p);
        }
      }
      this.emit(RoomEvent.ConnectionStateChanged, 'connected');
    }

    _limpiarPipelineRemoto(sid) {
      const pipe = this._rxPipelines.get(sid);
      if (!pipe) return;
      this._rxPipelines.delete(sid);
      try { if (pipe.opusDecoder && pipe.opusDecoder.state !== 'closed') pipe.opusDecoder.close(); } catch {}
      try { if (pipe.worklet) pipe.worklet.disconnect(); } catch {}
      try { if (pipe.proc) pipe.proc.disconnect(); } catch {}
      try { if (pipe.gainNode) pipe.gainNode.disconnect(); } catch {}
    }

    // Crea un pipeline receptor continuo en un único AudioContext (sin cruzar
    // MediaStreams entre dos AudioContext) y con soporte AudioWorklet en el
    // hilo de audio de tiempo real para eliminar al 100% el ruido y los cortes.
    _asegurarAudioRemoto(p, source, nombre) {
      let pub = p.pubs.get(source);
      if (pub) return pub;

      const ctx = this._asegurarRxAudioCtx();
      const ctxRate = ctx.sampleRate || 48000;
      const dest = ctx.createMediaStreamDestination();
      const gainNode = ctx.createGain();
      gainNode.gain.value = 1.0;
      gainNode.connect(ctx.destination);
      gainNode.connect(dest);

      const msTrack = dest.stream.getAudioTracks()[0];
      const track = new MediaTrack('audio', source, msTrack);
      const room = this;
      track.setDirectOutput = (vol, sinkId) => {
        if (typeof vol === 'number' && !Number.isNaN(vol)) {
          gainNode.gain.value = Math.max(0, Math.min(3, vol));
          // la voz suena por el reproductor único: recordar el factor por
          // hablante para que _feedVoz lo aplique al cambiar de frase
          room._volPorId.set(p.identity, Math.max(0, Math.min(3, vol)));
        }
        if (sinkId && typeof ctx.setSinkId === 'function') {
          ctx.setSinkId(sinkId).catch(() => {});
        }
        if (ctx.state === 'suspended') {
          ctx.resume().catch(() => {});
        }
      };

      const sid = 'TR_' + source + '_' + p.identity;
      pub = new TrackPublication(source, track, sid, nombre);
      p.pubs.set(source, pub);

      const cap = Math.ceil(ctxRate * 4);
      const pipe = {
        ctx,
        ctxRate,
        dest,
        gainNode,
        pub,
        p,
        worklet: null,
        proc: null,
        // Estado del Ring Buffer para fallback ScriptProcessor (si AudioWorklet no está activo)
        ring: new Float32Array(cap),
        cap,
        writePos: 0,
        readPosF: 0,
        available: 0,
        playing: false,
        eosPending: false,
        waitSamples: 0,
        underrunSamples: 0,
        lastOut: 0,
        fadeInPos: 0,
        fadeInLen: Math.ceil(ctxRate * 0.005),
        readRate: 1.0,
        targetSamples: Math.ceil(ctxRate * 0.06), // 60 ms inicial: tiempo real instantáneo
        // Estado de remuestreo continuo entre paquetes consecutivos
        rxPhase: 0,
        rxLastInSample: 0,
        rxHasLast: false,
        // Medición de jitter sólo entre secuencias consecutivas
        lastArrivalMs: 0,
        lastSeq: -1,
        jitterMs: 15,
        opusDecoder: null,
        opusTimestampUs: 0,
        // Pareo de sub-tramas Opus de 20 ms -> bloque de 40 ms: la cola lleva
        // {seq, crudo} por cada chunk decodificado y el mapa junta las 2
        // mitades del mismo seq antes de alimentar la cola de segmentos
        _opusSeqQ: [],
        _opusAcc: new Map(),
      };

      const esVoz = source === TrackSource.Microphone;
      const conectarWorkletSiListo = () => {
        if (esVoz || pipe.worklet || !ctx._workletListo || typeof window.AudioWorkletNode !== 'function') {
          return false;
        }
        try {
          const wn = new window.AudioWorkletNode(ctx, 'conferencia-rx-worklet', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [1],
          });
          wn.connect(gainNode);
          pipe.worklet = wn;
          if (pipe.proc) {
            try { pipe.proc.disconnect(); } catch {}
            pipe.proc = null;
          }
          return true;
        } catch {
          return false;
        }
      };

      // La voz no crea reproductor por hablante: suena por el reproductor
      // único ordenado (_asegurarVozPipe). El pipe solo guarda el estado del
      // decodificador/remuestreo por hablante.
      if (!esVoz && !conectarWorkletSiListo()) {
        // Fallback inmediato con ScriptProcessor(2048) conectado directo a gainNode -> ctx.destination
        const proc = ctx.createScriptProcessor(2048, 1, 1);
        proc.onaudioprocess = (ev) => {
          const out = ev.outputBuffer.getChannelData(0);
          const n = out.length;

          if (!pipe.playing) {
            if (pipe.available > 0) {
              pipe.waitSamples += n;
              if (
                pipe.available >= pipe.targetSamples ||
                pipe.eosPending ||
                pipe.waitSamples >= pipe.ctxRate * 0.08
              ) {
                pipe.playing = true;
                pipe.waitSamples = 0;
                pipe.underrunSamples = 0;
                pipe.fadeInPos = 0;
              }
            } else {
              pipe.waitSamples = 0;
            }
            if (!pipe.playing) {
              for (let i = 0; i < n; i++) out[i] = 0;
              return;
            }
          }

          const over = pipe.available - pipe.targetSamples;
          let desired = 1.0;
          // respaldo sin SOLA: limitar a +4% (imperceptible) para no subir
          // el tono — salvo con retraso enorme (velMax≥2): llegar al presente
          if (over > pipe.ctxRate * 0.05) {
            const capVel = pipe.velMax >= 2 ? pipe.velMax : 1.04;
            desired = Math.min(capVel, 1.0 + (over / pipe.ctxRate) * 0.35);
          } else if (!pipe.eosPending && pipe.available < pipe.targetSamples * 0.4) {
            desired = 0.96;
          }
          pipe.readRate += (desired - pipe.readRate) * 0.15;

          const ring = pipe.ring;
          const capLocal = pipe.cap;
          for (let i = 0; i < n; i++) {
            if (pipe.available > 1.05) {
              const idx0 = pipe.readPosF | 0;
              const frac = pipe.readPosF - idx0;
              const idx1 = (idx0 + 1) % capLocal;
              let s = ring[idx0] + frac * (ring[idx1] - ring[idx0]);
              pipe.readPosF = (pipe.readPosF + pipe.readRate) % capLocal;
              pipe.available -= pipe.readRate;
              if (pipe.fadeInPos < pipe.fadeInLen) {
                s *= pipe.fadeInPos / pipe.fadeInLen;
                pipe.fadeInPos++;
              }
              out[i] = s;
              pipe.lastOut = s;
              pipe.underrunSamples = 0;
            } else {
              pipe.lastOut *= 0.982;
              if (Math.abs(pipe.lastOut) < 0.0001) pipe.lastOut = 0;
              out[i] = pipe.lastOut;
              pipe.underrunSamples++;
              if (pipe.eosPending || pipe.underrunSamples > pipe.ctxRate * 0.045) {
                pipe.playing = false;
                pipe.eosPending = false;
                pipe.waitSamples = 0;
                pipe.available = 0;
                pipe.readPosF = pipe.writePos;
                for (let k = i + 1; k < n; k++) out[k] = 0;
                return;
              }
            }
          }
        };
        proc.connect(gainNode);
        pipe.proc = proc;
        asegurarWorkletEnCtx(ctx).then((ok) => {
          if (ok && this._rxPipelines.get(sid) === pipe) {
            conectarWorkletSiListo();
          }
        });
      }

      this._rxPipelines.set(sid, pipe);
      this.emit(RoomEvent.TrackSubscribed, track, pub, p);
      return pub;
    }

    _marcarFinHablaRemota(pipe) {
      if (!pipe) return;
      pipe.rxHasLast = false;
      pipe.rxPhase = 0;
      pipe.lastSeq = -1;
      pipe.eosPending = true;
      if (pipe.worklet) {
        try { pipe.worklet.port.postMessage({ t: 'eos' }); } catch {}
      }
    }

    // Remuestrea continuamente y empuja un bloque decodificado al reproductor.
    // La voz (FRAME_AUDIO) va a la cola ordenada de segmentos; el audio
    // compartido (música) sigue yendo directo al reproductor del hablante.
    _empujarMuestrasRemotas(pipe, samples, inRate, fromId, ftipo, seq, crudo) {
      if (!samples || samples.length === 0) return;
      const nowMs = performance.now();

      // Medir jitter real sólo cuando los números de secuencia (1 por cada 40 ms) son consecutivos
      if (typeof seq === 'number' && seq >= 0) {
        if (pipe.lastSeq >= 0) {
          const diff = (seq - pipe.lastSeq) & 0xffff;
          if (diff === 1 && pipe.lastArrivalMs > 0) {
            const deltaMs = nowMs - pipe.lastArrivalMs;
            if (deltaMs < 500) {
              const jit = Math.abs(deltaMs - 40);
              pipe.jitterMs = pipe.jitterMs * 0.85 + jit * 0.15;
              const targetMs = Math.max(55, Math.min(180, 50 + pipe.jitterMs * 1.4));
              pipe.targetSamples = Math.ceil(pipe.ctxRate * (targetMs / 1000));
              if (pipe.worklet) {
                try { pipe.worklet.port.postMessage({ t: 'target', ms: targetMs }); } catch {}
              }
            }
          } else if (diff > 1 && diff < 30000) {
            pipe.rxHasLast = false;
            pipe.rxPhase = 0;
          }
        }
        pipe.lastSeq = seq;
        pipe.lastArrivalMs = nowMs;
      } else if (seq === -1 && pipe.lastSeq < 0) {
        if (pipe.lastArrivalMs > 0 && (nowMs - pipe.lastArrivalMs) > 450) {
          pipe.rxHasLast = false;
          pipe.rxPhase = 0;
        }
        pipe.lastArrivalMs = nowMs;
      }
      pipe.eosPending = false;

      const nIn = samples.length;
      let sum = 0;
      for (let i = 0; i < nIn; i += 4) {
        sum += samples[i] * samples[i];
      }
      const rms = Math.sqrt(sum / Math.max(1, Math.ceil(nIn / 4)));
      if (ftipo === FRAME_AUDIO && rms > 0.006) {
        this._speakers.set(fromId, Date.now() + 650);
        this._actualizarSpeakers();
      }

      // Remuestrear a la tasa exacta del AudioContext con fase continua
      let outPcm;
      if (inRate === pipe.ctxRate) {
        outPcm = samples;
        pipe.rxLastInSample = samples[nIn - 1];
        pipe.rxHasLast = true;
        pipe.rxPhase = 0;
      } else {
        const step = inRate / pipe.ctxRate;
        if (!pipe.rxHasLast) {
          pipe.rxLastInSample = samples[0];
          pipe.rxHasLast = true;
          pipe.rxPhase = 0;
        }
        const estLen = Math.ceil((nIn - pipe.rxPhase) / step) + 2;
        const tmp = new Float32Array(Math.max(1, estLen));
        let outIdx = 0;
        while (pipe.rxPhase < nIn) {
          const idx = pipe.rxPhase | 0;
          const frac = pipe.rxPhase - idx;
          const s0 = idx === 0 ? pipe.rxLastInSample : samples[idx - 1];
          const s1 = samples[idx];
          tmp[outIdx++] = s0 + frac * (s1 - s0);
          pipe.rxPhase += step;
        }
        pipe.rxPhase -= nIn;
        pipe.rxLastInSample = samples[nIn - 1];
        outPcm = tmp.subarray(0, outIdx);
      }

      // Voz: a la cola ordenada de segmentos (notas de voz en vivo)
      if (ftipo === FRAME_AUDIO) {
        this._alimentarSegVoz(fromId, outPcm, seq, crudo);
        return;
      }

      if (pipe.worklet) {
        try {
          pipe.worklet.port.postMessage({ t: 'push', pcm: outPcm });
          return;
        } catch {}
      }

      // Empujar al Ring Buffer del fallback ScriptProcessor (tope 260 ms en vivo)
      const hardCap = pipe.ctxRate * 0.26;
      if (pipe.available + outPcm.length > hardCap) {
        const keep = Math.ceil(pipe.ctxRate * 0.08);
        const drop = Math.max(0, (pipe.available + outPcm.length) - keep);
        pipe.readPosF = (pipe.readPosF + drop) % pipe.cap;
        pipe.available = Math.max(0, pipe.available - drop);
        pipe.fadeInPos = 0;
      }
      const ring = pipe.ring;
      const cap = pipe.cap;
      for (let i = 0; i < outPcm.length; i++) {
        if (pipe.available < cap) {
          ring[pipe.writePos] = outPcm[i];
          pipe.writePos = (pipe.writePos + 1) % cap;
          pipe.available++;
        }
      }
    }

    _asegurarVideoRemoto(p, source, width, height) {
      let pub = p.pubs.get(source);
      if (pub) return pub;

      const cv = document.createElement('canvas');
      cv.width = width;
      cv.height = height;
      const cx = cv.getContext('2d');
      const track = new MediaTrack('video', source, null);
      track._canvas = cv;
      track._ctx2d = cx;
      const sid = 'TR_' + source + '_' + p.identity;
      pub = new TrackPublication(source, track, sid, source);
      p.pubs.set(source, pub);
      this.emit(RoomEvent.TrackSubscribed, track, pub, p);
      return pub;
    }

    _manejarBinario(u8) {
      if (u8.length < 4) return;
      const ftipo = u8[0];
      const idLen = u8[1];
      if (2 + idLen > u8.length) return;
      const fromId = new TextDecoder().decode(u8.subarray(2, 2 + idLen));
      if (!fromId || fromId === this.localParticipant.identity) return;
      const payload = u8.subarray(2 + idLen);

      let p = this.remoteParticipants.get(fromId);
      if (!p) {
        p = new Participant(fromId, fromId, false, this);
        this.remoteParticipants.set(fromId, p);
        this.emit(RoomEvent.ParticipantConnected, p);
      }

      if (ftipo === FRAME_AUDIO || ftipo === FRAME_AUDIO_SHARE) {
        if (payload.length < 1) return;
        const rateCode = payload[0];

        const source = ftipo === FRAME_AUDIO_SHARE ? TrackSource.ScreenShareAudio : TrackSource.Microphone;
        const pub = this._asegurarAudioRemoto(p, source, ftipo === FRAME_AUDIO_SHARE ? '🎵 Audio' : 'microfono');
        if (pub.isMuted) {
          pub.isMuted = false;
          this.emit(RoomEvent.TrackUnmuted, pub, p);
        }

        const pipe = this._rxPipelines.get(pub.trackSid);
        if (!pipe) return;
        this._asegurarRxAudioCtx();

        // 0. Marcador explícito de fin de frase (EOS): reproduce de inmediato
        // cualquier sílaba corta pendiente y apaga la frase sin PLC ni retraso.
        if (rateCode === 0) {
          if (ftipo === FRAME_AUDIO) {
            // fin de la nota de voz en vivo: el segmento queda listo para
            // cerrarse cuando se agoten sus bloques (seg_fin lo confirma)
            const oseq = this._segPorHablante.get(fromId);
            const sg = oseq != null ? this._vozSegs.get(oseq) : null;
            if (sg) {
              sg.finLocal = true;
              this._segPorHablante.delete(fromId);
            }
            pipe.rxHasLast = false;
            pipe.rxPhase = 0;
            pipe.lastSeq = -1;
          } else {
            this._marcarFinHablaRemota(pipe);
          }
          return;
        }

        // Dedup temprano en ventana deslizante: la copia redundante del
        // mismo paquete NO debe entrar al decodificador — Opus y ADPCM son
        // decoders CON ESTADO (historial/predictor) y decodificar la misma
        // trama dos veces corrompe el estado y ensucia los frames
        // siguientes ("basurita" de fondo). Ventana corta: cubre reenvíos
        // sin tropezar con seqs repetidos cuando aid (4 bits) da la vuelta.
        if (rateCode >= 10 && payload.length >= 3) {
          const seqWire = payload[1] | (payload[2] << 8);
          if (!pipe._txVistos) { pipe._txVistos = new Set(); pipe._txOrden = []; }
          if (pipe._txVistos.has(seqWire)) return;
          pipe._txVistos.add(seqWire);
          pipe._txOrden.push(seqWire);
          if (pipe._txOrden.length > 512) pipe._txVistos.delete(pipe._txOrden.shift());
        }

        // 1. Trama Opus nativa ultraligera (14 / 22 / 32 kbps)
        if (rateCode >= 10 && rateCode <= 19) {
          if (!SOPORTE_OPUS_RX || typeof window.AudioDecoder !== 'function') return;
          try {
            if (!pipe.opusDecoder || pipe.opusDecoder.state === 'closed') {
              pipe.opusDecoder = new window.AudioDecoder({
                output: (audioData) => {
                  const sRate = audioData.sampleRate || 48000;
                  const pcm = extraerFloat32DeAudioData(audioData);
                  audioData.close();
                  const it = (pipe._opusSeqQ && pipe._opusSeqQ.length)
                    ? pipe._opusSeqQ.shift() : { seq: -1, crudo: null };
                  if (it.seq < 0) {
                    this._empujarMuestrasRemotas(pipe, pcm, sRate, fromId, ftipo, -1, it.crudo);
                    return;
                  }
                  // Cada paquete trae 2 sub-tramas de 20 ms con el MISMO seq:
                  // se juntan en un solo bloque de 40 ms (1 bloque = 1 idx) —
                  // antes la 2ª mitad entraba suelta con seq=-1 y el orden
                  // de la cola quedaba revuelto (trozos repetidos/cortados)
                  let acc = pipe._opusAcc.get(it.seq);
                  if (!acc) {
                    acc = { parts: [], crudo: it.crudo, timer: 0 };
                    acc.timer = setTimeout(() => {
                      const a = pipe._opusAcc.get(it.seq);
                      if (!a) return;
                      pipe._opusAcc.delete(it.seq);
                      // Media trama real (el emisor perdió el gemelo):
                      // rellenar a 40 ms conservando el seq — antes se
                      // encolaba suelta con seq=-1, fuera de orden, y con
                      // 20 ms menos desplazaba el resto de la frase
                      const solo = a.parts[0];
                      const pad = new Float32Array(Math.max(1920, solo.length));
                      pad.set(solo);
                      const fade0 = Math.max(0, solo.length - 240);
                      for (let k = fade0; k < solo.length; k++) {
                        pad[k] *= (solo.length - k) / 240;
                      }
                      this._empujarMuestrasRemotas(pipe, pad, sRate, fromId, ftipo, it.seq, a.crudo);
                    }, 120);
                    pipe._opusAcc.set(it.seq, acc);
                  }
                  acc.parts.push(pcm);
                  if (acc.parts.length >= 2) {
                    clearTimeout(acc.timer);
                    pipe._opusAcc.delete(it.seq);
                    const j = new Float32Array(acc.parts[0].length + acc.parts[1].length);
                    j.set(acc.parts[0]);
                    j.set(acc.parts[1], acc.parts[0].length);
                    this._empujarMuestrasRemotas(pipe, j, sRate, fromId, ftipo, it.seq, acc.crudo);
                  }
                },
                error: () => {
                  // mantener la alineación seq<->salida tras un error del decoder
                  if (pipe._opusSeqQ && pipe._opusSeqQ.length) pipe._opusSeqQ.shift();
                },
              });
              pipe.opusDecoder.configure({
                codec: 'opus',
                sampleRate: 48000,
                numberOfChannels: 1,
              });
            }
            // Formato v2 dual (2 sub-tramas Opus de 20 ms con secuencia):
            // payload = [rateCode, seqLo, seqHi, 0xA5, len1Lo, len1Hi, ...b1..., len2Lo, len2Hi, ...b2...]
            if (!pipe._opusSeqQ) { pipe._opusSeqQ = []; pipe._opusAcc = new Map(); }
            if (payload.length > 8 && payload[3] === 0xA5) {
              const seq = payload[1] | (payload[2] << 8);
              const len1 = payload[4] | (payload[5] << 8);
              const off1 = 6;
              if (off1 + len1 <= payload.length && len1 > 0) {
                const b1 = payload.subarray(off1, off1 + len1);
                pipe._opusSeqQ.push({ seq, crudo: payload });
                const ch1 = new window.EncodedAudioChunk({
                  type: 'key',
                  timestamp: pipe.opusTimestampUs,
                  duration: 20000,
                  data: b1,
                });
                pipe.opusTimestampUs += 20000;
                pipe.opusDecoder.decode(ch1);
              }
              const off2 = off1 + len1;
              if (off2 + 2 <= payload.length) {
                const len2 = payload[off2] | (payload[off2 + 1] << 8);
                if (off2 + 2 + len2 <= payload.length && len2 > 0) {
                  const b2 = payload.subarray(off2 + 2, off2 + 2 + len2);
                  pipe._opusSeqQ.push({ seq, crudo: payload });
                  const ch2 = new window.EncodedAudioChunk({
                    type: 'key',
                    timestamp: pipe.opusTimestampUs,
                    duration: 20000,
                    data: b2,
                  });
                  pipe.opusTimestampUs += 20000;
                  pipe.opusDecoder.decode(ch2);
                }
              }
            } else {
              // Retrocompatibilidad con trama Opus simple
              const opusBytes = payload.subarray(1);
              pipe._opusSeqQ.push({ seq: -1, crudo: payload });
              const chunk = new window.EncodedAudioChunk({
                type: 'key',
                timestamp: pipe.opusTimestampUs,
                duration: 20000,
                data: opusBytes,
              });
              pipe.opusTimestampUs += 20000;
              pipe.opusDecoder.decode(chunk);
            }
          } catch {}
          return;
        }

        // 2. Trama IMA-ADPCM limpia de 4 bits (8 kHz / 12 kHz / 16 kHz)
        if (rateCode >= 20 && rateCode <= 39) {
          const baseCode = rateCode >= 30 ? (rateCode - 10) : rateCode;
          const esV2 = payload.length >= 7 && payload[6] === 0x5A;
          const sampleRate = esV2
            ? (baseCode === 21 ? 8000 : (baseCode === 22 ? 12000 : 16000))
            : (baseCode === 21 ? 6000 : (baseCode === 22 ? 8000 : (baseCode === 23 ? 12000 : 16000)));
          const { pcm, seq } = decodificarBloqueADPCM(payload);
          this._empujarMuestrasRemotas(pipe, pcm, sampleRate, fromId, ftipo, seq, payload);
          return;
        }

        // 3. Retrocompatibilidad con tramas µ-law antiguas (rateCode 1 = 8kHz, 2 = 12kHz)
        const sampleRate = rateCode === 1 ? 8000 : 12000;
        const samples = payload.subarray(1);
        const pcm = new Float32Array(samples.length);
        for (let i = 0; i < samples.length; i++) {
          pcm[i] = ulawDecodeTable[samples[i]];
        }
        this._empujarMuestrasRemotas(pipe, pcm, sampleRate, fromId, ftipo, -1, payload);
        return;
      }

      if (ftipo === FRAME_VIDEO || ftipo === FRAME_SCREEN) {
        const isScreen = ftipo === FRAME_SCREEN;
        const source = isScreen ? TrackSource.ScreenShare : TrackSource.Camera;
        const pub = this._asegurarVideoRemoto(p, source, isScreen ? 854 : 320, isScreen ? 480 : 240);
        const blob = new Blob([payload], { type: 'image/webp' });
        if (window.createImageBitmap) {
          createImageBitmap(blob).then((bmp) => {
            const cv = pub.track._canvas;
            const cx = pub.track._ctx2d;
            if (cv && cx) {
              cx.drawImage(bmp, 0, 0, cv.width, cv.height);
            }
            bmp.close();
          }).catch(() => {});
        } else {
          const url = URL.createObjectURL(blob);
          const img = new Image();
          img.onload = () => {
            const cv = pub.track._canvas;
            const cx = pub.track._ctx2d;
            if (cv && cx) cx.drawImage(img, 0, 0, cv.width, cv.height);
            URL.revokeObjectURL(url);
          };
          img.onerror = () => URL.revokeObjectURL(url);
          img.src = url;
        }
      }
    }
  }

  window.LivekitClient = {
    Room,
    RoomEvent,
    Track: { Source: TrackSource },
    ConnectionQuality,
    DisconnectReason,
    VideoPresets,
    AudioPresets,
  };
})();

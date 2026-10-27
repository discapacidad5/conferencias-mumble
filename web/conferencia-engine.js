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
    this.cap = Math.ceil(rate * 1.5);
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
    this.velMax = 1.12;
    this.targetSamples = Math.ceil(rate * 0.06); // 60 ms: tiempo real instantáneo
    // SOLA: cola de las últimas muestras emitidas, para alinear por
    // correlación cada ventana al acelerar (drenar rápido sin subir el tono)
    this.solaOv = Math.ceil(rate * 0.01); // solape de 10 ms
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
      if (d.t === 'vel' && typeof d.v === 'number') {
        // Drenaje acelerado cuando hay historial atrasado (hasta ~1.35x)
        this.velMax = Math.max(1.05, Math.min(1.4, d.v));
        return;
      }
      if (d.t === 'target' && typeof d.ms === 'number') {
        this.targetSamples = Math.ceil(this.rate * (Math.max(55, Math.min(180, d.ms)) / 1000));
        return;
      }
      if (d.t === 'cap' && typeof d.ms === 'number') {
        // Tope de cola configurable: música en vivo 260 ms; la tubería de
        // notas de voz necesita ~1,4 s para no recortar frases al drenar
        this.capMs = Math.max(0.1, Math.min(1.45, d.ms / 1000));
        return;
      }
      if (d.t === 'push' && d.pcm) {
        const src = d.pcm;
        const n = src.length;
        if (n === 0) return;
        this.eosPending = false;
        // Tope de la cola (capMs): por defecto 260 ms en vivo; la tubería de
        // segmentos lo sube para guardar historial en espera de sonar
        const hardCap = this.rate * (this.capMs || 0.26);
        if (this.available + n > hardCap) {
          const keep = Math.ceil(this.rate * 0.08);
          const drop = Math.max(0, (this.available + n) - keep);
          this.readPosF = (this.readPosF + drop) % this.cap;
          this.available = Math.max(0, this.available - drop);
          this.fadeInPos = 0;
        }
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

    // Drenar micro-retrasos deprisa (+12% normal, hasta +35% con historial atrasado)
    const over = this.available - this.targetSamples;
    let desired = 1.0;
    if (over > this.rate * 0.05) {
      desired = Math.min(this.velMax, 1.0 + (over / this.rate) * 0.35);
    } else if (!this.eosPending && this.available < this.targetSamples * 0.4) {
      desired = 0.96;
    }
    this.readRate += (desired - this.readRate) * 0.15;

    // Aceleración con SOLA (overlap-add alineado por correlación): consume
    // más entrada de la que emite sin cambiar el tono de la voz. Se usa en
    // el rango 1.02–1.9×; por encima el retraso es tan grande que la voz ya
    // no se entiende ni con SOLA, y conviene el salto directo (resampleo
    // barato) para llegar al presente cuanto antes.
    if (this.readRate > 1.02 && this.readRate < 1.9 &&
        this.available > n * this.readRate + this.rate * 0.05) {
      this._sola(out, n);
      return true;
    }

    const ring = this.ring;
    const cap = this.cap;
    for (let i = 0; i < n; i++) {
      if (this.available > 1.05) {
        const idx0 = this.readPosF | 0;
        const frac = this.readPosF - idx0;
        const idx1 = (idx0 + 1) % cap;
        let s = ring[idx0] + frac * (ring[idx1] - ring[idx0]);
        this.readPosF = (this.readPosF + this.readRate) % cap;
        this.available -= this.readRate;
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
        if (this.eosPending || this.underrunSamples > this.rate * 0.045) {
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
    // Guardar la cola de salida para alinear la próxima ventana SOLA
    if (n >= this.solaOv) this.solaTail.set(out.subarray(n - this.solaOv));
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
      let opusPending = [];
      let txSeq = 0;
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
                opusPending.push(bytes);
                opusListo = true;
                // Agrupamos 2 sub-tramas Opus de 20 ms (= 40 ms por paquete WebSocket)
                if (opusPending.length >= 2) {
                  const b1 = opusPending.shift();
                  const b2 = opusPending.shift();
                  const rateCode = maxBr <= 11000 ? 10 : (maxBr <= 20000 ? 11 : 12);
                  const s = txSeq & 0xffff;
                  const pkt = new Uint8Array(9 + b1.length + b2.length);
                  pkt[0] = FRAME_AUDIO;
                  pkt[1] = rateCode;
                  pkt[2] = s & 0xff;
                  pkt[3] = (s >> 8) & 0xff;
                  pkt[4] = 0xA5; // marca de paquete Opus dual (2 x 20ms)
                  pkt[5] = b1.length & 0xff;
                  pkt[6] = (b1.length >> 8) & 0xff;
                  pkt.set(b1, 7);
                  const off2 = 7 + b1.length;
                  pkt[off2] = b2.length & 0xff;
                  pkt[off2 + 1] = (b2.length >> 8) & 0xff;
                  pkt.set(b2, off2 + 2);
                  // Encolado confiable: nunca se pierde la voz del emisor
                  // ante micro-cortes — sale en ráfaga al volver el socket
                  this._room._enviarFrame(pkt);
                }
              },
              error: () => {
                opusListo = false;
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

      // Enviar 3 marcadores cortos EOS espaciados 25ms fuerza 3 DupACKs (TCP Fast Retransmit)
      // en caso de que el último paquete de voz se haya perdido en un WiFi débil.
      const enviarMarcadorEOS = () => {
        const sendOne = () => {
          if (!this._room) return;
          const s = (txSeq = (txSeq + 1) & 0xffff);
          const eos = new Uint8Array([FRAME_AUDIO, 0, s & 0xff, (s >> 8) & 0xff]);
          this._room._enviarFrame(eos);
        };
        sendOne();
        setTimeout(sendOne, 25);
        setTimeout(sendOne, 50);
      };

      // Enviar un bloque de 40 ms (1920 muestras @ 48 kHz). Si el socket está
      // caído o saturado se encola en vez de descartarse: la frase llega
      // completa al servidor aunque el oyente la oiga con retraso.
      const enviarTrama40ms = (frame48k) => {
        if (!this._room) return;
        txSeq = (txSeq + 1) & 0xffff;

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
                timestamp: opusTimestampUs,
                data: sub20ms,
              });
              opusTimestampUs += 20000;
              opusEncoder.encode(ad);
              ad.close();
            }
            enviadoOpus = true;
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
          this._room._enviarFrame(pkt);
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

              if (!hablandoActivo && rms < noiseFloor * 1.5) {
                noiseFloor = Math.max(0.0008, Math.min(0.0032, noiseFloor * 0.95 + rms * 0.05));
              }
              const sens = (window.S && S.ptt && S.ptt.sens) || 2.0;
              const umbralAbrir = Math.max(0.0032, noiseFloor * sens);
              const umbralMantener = Math.max(0.0014, noiseFloor * 1.15);
              // ataque: N tramas seguidas de voz antes de activar (evita que
              // un golpe o ruido ambiente aislado "pise el botón" en auto)
              const ataqueN = Math.max(1, Math.round(((window.S && S.ptt && S.ptt.ataque) || 0.12) / 0.04));
              if (rms >= umbralAbrir) vozSeg++; else vozSeg = 0;
              const vozOk = rms >= (hablandoActivo ? umbralMantener : umbralAbrir)
                && (hablandoActivo || vozSeg >= ataqueN);

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
                    opusPending.length = 0;
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
              } else if (vozOk || (window.S && S.ptt && S.ptt.quiero)) {
                // Modo automático: la voz pisa el botón. El micro escucha en
                // local SIEMPRE, pero al servidor solo se transmite cuando el
                // piso ya es mío (S.ptt.tengo): sin piso no se gasta subida.
                const tengo = window.S && S.ptt && S.ptt.tengo;
                if (!hablandoActivo) {
                  hablandoActivo = true;
                  opusPending.length = 0;
                  ultimoPedirPiso = performance.now();
                  autoPreTs = ultimoPedirPiso;
                  if (this._room) this._room.tomarPiso();
                  // pre-roll de 40 ms guardado: se suelta apenas concedan el
                  // piso para conservar el ataque de la primera sílaba
                  autoPre = tienePrevFrame ? new Float32Array(prevFrame48k) : null;
                }
                // Cola de silencio configurable ("Soltar tras N s", tope 5 s)
                const silSeg = Math.min(5, (window.S && S.ptt && S.ptt.silencio) || 2.2);
                silencioCola = Math.max(8, Math.round(silSeg / 0.04));
                this._room._marcarHablandoLocal(true);
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
              } else if (silencioCola > 0) {
                silencioCola--;
                if (silencioCola === 0) {
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
                  enviarTrama40ms(frameBuf);
                }
              } else {
                hablandoActivo = false;
                this._room._marcarHablandoLocal(false);
                if (pendingBr !== null && pendingBr !== maxBr) {
                  configurarOpus(pendingBr);
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
      this._vozRate = 48000;
      this._feedT = null;
      this._feedUltimo = 0;
      this._fetchSegs = new Set();      // seqs con descarga en curso
      this._replayQ = [];               // notas re-escuchadas (prioridad)
      this._replayPendMs = 0;           // ms de nota ya en el reproductor sin sonar
      this._replayPlayedMs = 0;         // ms acumulados de nota ya escuchados
      this._replayProg = [];            // {seq, msTotal, finMs} para progreso/fin
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
    _enviarJson(obj) {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
      try { this._ws.send(JSON.stringify(obj)); } catch {}
    }

    _enviarFrame(pkt) {
      if (this._ws && this._ws.readyState === WebSocket.OPEN && this._ws.bufferedAmount < 12 * 1024) {
        try { this._ws.send(pkt); return; } catch {}
      }
      // ~1.5 MB ≈ 2-3 min de voz a 10 kbps: por encima la red lleva muerta
      // demasiado y encolar más solo infla la memoria del teléfono
      if (this._txBytes + pkt.length <= 1572864) {
        this._txCola.push(pkt);
        this._txBytes += pkt.length;
        this._programarFlushTx();
      }
    }

    _programarFlushTx() {
      if (this._txFlushT) return;
      this._txFlushT = setTimeout(() => { this._txFlushT = null; this._drenarTx(); }, 300);
    }

    _drenarTx() {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
      // Drenar por debajo de 12 KB en bufferedAmount para no disparar el
      // watchdog de socket congelado (que reemplaza el socket a los 14 KB)
      while (this._txCola.length && this._ws.bufferedAmount < 12 * 1024) {
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

    // ---------- piso exclusivo (PTT) ----------
    tomarPiso() {
      this._quieroPiso = true;
      this._enviarJson({ t: 'piso_tomar' });
      this._latidoPiso();
    }

    soltarPiso() {
      this._quieroPiso = false;
      this._tengoPiso = false;
      if (this._pisoHoldT) { clearInterval(this._pisoHoldT); this._pisoHoldT = null; }
      this._enviarJson({ t: 'piso_soltar' });
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

    _vozSegNuevo(seq, de, nombre, abierto, meta) {
      let seg = this._vozSegs.get(seq);
      if (!seg) {
        seg = {
          seq, de: de || '', nombre: nombre || de || '',
          abierto: !!abierto, completo: !abierto, finLocal: !abierto,
          pseudo: false,
          durMs: (meta && meta.durMs) || 0,
          interrumpida: !!(meta && (meta.interrumpida || meta.cortado)),
          inicio: (meta && meta.inicio) || Date.now(),
          bloques: [], vistos: new Set(), ultTx: -1, huecos: false,
          alimentado: 0, bajando: false, descargado: false, perdido: false,
          saltado: false, reproducido: false, finAvisado: false, bajaDesde: 0,
          _repT: null, raw: [], rawBytes: 0,
        };
        this._vozSegs.set(seq, seg);
        let i = this._vozOrden.length;
        while (i > 0 && (this._vozOrden[i - 1].pseudo ? Infinity : this._vozOrden[i - 1].seq) > seq) i--;
        this._vozOrden.splice(i, 0, seg);
      } else {
        if (de && !seg.de) seg.de = de;
        if (nombre) seg.nombre = nombre;
        if (!abierto) seg.completo = true;
        if (meta && meta.durMs) seg.durMs = meta.durMs;
        if (meta && (meta.interrumpida || meta.cortado)) seg.interrumpida = true;
        if (meta && meta.inicio) seg.inicio = meta.inicio;
      }
      if (abierto && de) this._segPorHablante.set(de, seq);
      if (typeof seq === 'number' && seq > 0) this._ultimoSeg = Math.max(this._ultimoSeg, seq);
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

    // Inserta un bloque decodificado en el segmento, ordenado por txSeq
    // (los huecos reparados se insertan en su posición correcta)
    _insertarBloque(seg, bl) {
      if (typeof bl.tx !== 'number' || bl.tx < 0) {
        seg.bloques.push(bl);
        return;
      }
      let i = seg.bloques.length;
      while (i > 0 && ((seg.bloques[i - 1].tx - bl.tx) & 0xffff) < 30000) i--;
      seg.bloques.splice(i, 0, bl);
      if (i < seg.alimentado) seg.alimentado = i; // reposición de un hueco
      if (seg.reproducido && i < seg.bloques.length) seg.reproducido = false;
    }

    _programarReparacion(seg) {
      if (seg._repT || seg.bajando || seg.descargado) return;
      seg._repT = setTimeout(() => {
        seg._repT = null;
        if (seg.seq > 0) this._bajarSeg(seg.seq);
      }, 500);
    }

    // Trama de voz en vivo ya decodificada y remuestreada: entra a la cola
    // ordenada del segmento del hablante (no directo al altavoz)
    _alimentarSegVoz(fromId, pcm, txSeq, crudo) {
      if (!pcm || !pcm.length) return;
      let seg = null;
      const seq = this._segPorHablante.get(fromId);
      if (seq != null) seg = this._vozSegs.get(seq) || null;
      if (!seg) seg = this._segImplicito(fromId);

      if (typeof txSeq === 'number' && txSeq >= 0) {
        if (seg.vistos.has(txSeq)) return;
        seg.vistos.add(txSeq);
        if (seg.ultTx >= 0) {
          const diff = (txSeq - seg.ultTx) & 0xffff;
          if (diff > 1 && diff < 30000) {
            seg.huecos = true;
            this._programarReparacion(seg);
          }
        }
        if (seg.ultTx < 0 || ((txSeq - seg.ultTx) & 0xffff) < 30000) seg.ultTx = txSeq;
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
      const cap = Math.ceil(ctxRate * 8);
      const gainNode = ctx.createGain();
      gainNode.gain.value = 1.0;
      gainNode.connect(ctx.destination);
      const pipe = {
        ctx, ctxRate, gainNode, worklet: null, proc: null,
        ring: new Float32Array(cap), cap,
        writePos: 0, readPosF: 0, available: 0, playing: false,
        eosPending: true, waitSamples: 0, underrunSamples: 0,
        lastOut: 0, fadeInPos: 0, fadeInLen: Math.ceil(ctxRate * 0.005),
        readRate: 1.0, velMax: 1.12, eosSent: true,
        targetSamples: Math.ceil(ctxRate * 0.06),
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
          // esta tubería lleva notas de voz e historial: cola amplia (1,4 s)
          // para que el drenaje acelerado no recorte frases
          try { wn.port.postMessage({ t: 'cap', ms: 1400 }); } catch {}
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
          const over = pipe.available - pipe.targetSamples;
          let desired = 1.0;
          // respaldo sin SOLA: limitar a +4% (imperceptible) para no subir el
          // tono — salvo con retraso enorme (velMax≥2), donde importa llegar
          // al presente aunque el tono suba
          if (over > pipe.ctxRate * 0.05) {
            const capVel = pipe.velMax >= 2 ? pipe.velMax : 1.04;
            desired = Math.min(capVel, 1.0 + (over / pipe.ctxRate) * 0.35);
          } else if (!pipe.eosPending && pipe.available < pipe.targetSamples * 0.4) {
            desired = 0.96;
          }
          pipe.readRate += (desired - pipe.readRate) * 0.15;
          for (let i = 0; i < n; i++) {
            if (pipe.available > 1.05) {
              const idx0 = pipe.readPosF | 0;
              const frac = pipe.readPosF - idx0;
              const idx1 = (idx0 + 1) % pipe.cap;
              let s = pipe.ring[idx0] + frac * (pipe.ring[idx1] - pipe.ring[idx0]);
              pipe.readPosF = (pipe.readPosF + pipe.readRate) % pipe.cap;
              pipe.available -= pipe.readRate;
              if (pipe.fadeInPos < pipe.fadeInLen) { s *= pipe.fadeInPos / pipe.fadeInLen; pipe.fadeInPos++; }
              out[i] = s; pipe.lastOut = s; pipe.underrunSamples = 0;
            } else {
              pipe.lastOut *= 0.982;
              if (Math.abs(pipe.lastOut) < 0.0001) pipe.lastOut = 0;
              out[i] = pipe.lastOut;
              pipe.underrunSamples++;
              if (pipe.eosPending || pipe.underrunSamples > pipe.ctxRate * 0.045) {
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
      // fallback: ring buffer del ScriptProcessor — la tubería de notas de
      // voz conserva hasta 1,4 s de cola (historial) antes de recortar
      if (pipe.available + pcm.length > pipe.cap) {
        const drop = (pipe.available + pcm.length) - Math.ceil(pipe.ctxRate * 1.4);
        if (drop > 0) {
          pipe.readPosF = (pipe.readPosF + drop) % pipe.cap;
          pipe.available = Math.max(0, pipe.available - drop);
          pipe.fadeInPos = 0;
        }
      }
      const ring = pipe.ring, cap = pipe.cap;
      for (let i = 0; i < pcm.length && pipe.available < cap; i++) {
        ring[pipe.writePos] = pcm[i];
        pipe.writePos = (pipe.writePos + 1) % cap;
        pipe.available++;
      }
    }

    // Corazón de la reproducción ordenada: corre cada 60 ms. Alimenta el
    // reproductor único primero con notas re-escuchadas, luego con el
    // segmento más antiguo pendiente (las descargas bloquean en orden).
    _feedVoz() {
      const ahoraMs = performance.now();
      const dt = Math.min(250, ahoraMs - (this._feedUltimo || ahoraMs));
      this._feedUltimo = ahoraMs;
      const pipe = this._asegurarVozPipe();
      this._vozBufMs = Math.max(0, this._vozBufMs - dt * (this._velAct || 1.05));

      // 1. Notas re-escuchadas tienen prioridad y suenan a velocidad natural
      while (this._replayQ.length && this._vozBufMs < 550) {
        const rp = this._replayQ[0];
        while (rp.alimentado < rp.bloques.length && this._vozBufMs < 550) {
          const bl = rp.bloques[rp.alimentado++];
          this._vozEmpujar(bl.pcm);
          this._replayPendMs += (bl.pcm.length / pipe.ctxRate) * 1000;
        }
        if (rp.alimentado >= rp.bloques.length) this._replayQ.shift();
        else break;
      }
      // progreso real: la nota termina cuando sonó, no cuando se encoló
      if (this._replayPendMs > 0) {
        const paso = Math.min(this._replayPendMs, dt * 1.05);
        this._replayPendMs -= paso;
        this._replayPlayedMs += paso;
      }
      while (this._replayProg.length &&
             this._replayPlayedMs >= this._replayProg[0].finMs - 30) {
        this.emit('seg_replay_fin', this._replayProg.shift().seq);
      }
      if (this._replayProg.length && ahoraMs - (this._progUltimo || 0) > 200) {
        this._progUltimo = ahoraMs;
        const rp = this._replayProg[0];
        const pos = Math.max(0, Math.min(rp.msTotal,
          this._replayPlayedMs - (rp.finMs - rp.msTotal)));
        this.emit('seg_progreso',
          { seq: rp.seq, posMs: Math.round(pos), durMs: Math.round(rp.msTotal) });
      }

      // 2. Cabeza de la cola ordenada por seq
      let seg = null;
      for (const s of this._vozOrden) {
        if (s.saltado || s.reproducido) continue;
        seg = s;
        break;
      }
      if (seg) {
        if (seg.bajando) {
          // esperar la descarga; si se atascó >8 s se declara perdida
          if (ahoraMs - seg.bajaDesde > 8000) {
            seg.bajando = false;
            seg.perdido = true;
            seg.saltado = true;
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
          while (seg.alimentado < seg.bloques.length && this._vozBufMs < 550) {
            this._vozEmpujar(seg.bloques[seg.alimentado++].pcm);
          }
          if (seg.alimentado >= seg.bloques.length &&
              (seg.completo || seg.finLocal) && !seg.finAvisado) {
            seg.finAvisado = true;
            seg.reproducido = true;
            this.emit('seg_reproducido', this._segMeta(seg));
          }
        }
      }

      // 3. Velocidad de drenaje escalonada según el retraso respecto al
      // presente: a más atraso más aceleración (el audio queda grabado en
      // las notas, así que conviene llegar al vivo cuanto antes). Una nota
      // re-escuchada NO es retraso: siempre a velocidad natural.
      const retraso = this._retrasoMs();
      const replayActivo = this._replayQ.length > 0 ||
        this._replayProg.length > 0 || this._replayPendMs > 30;
      const vel = replayActivo ? 1.0
        : retraso > 60000 ? 4.0   // >1 min: casi a saltos, llegar ya
        : retraso > 30000 ? 2.5
        : retraso > 10000 ? 1.6
        : retraso > 5000 ? 1.33
        : retraso > 3000 ? 1.08
        : 1.0;                    // ≤3 s se considera en vivo: voz natural
      this._velAct = vel;
      if (vel !== pipe.velMax) {
        pipe.velMax = vel;
        if (pipe.worklet) {
          try { pipe.worklet.port.postMessage({ t: 'vel', v: vel }); } catch {}
        }
      }
      this._drenando = vel > 1.2;
      if (retraso !== this._retrasoAviso) {
        this._retrasoAviso = retraso;
        this.emit('voz_retraso', Math.round(retraso));
      }

      // 4. Cola vacía: marcar EOS para que el reproductor termine limpio
      const vacio = !seg && !this._replayQ.length && !this._replayProg.length;
      if (vacio && !pipe.eosSent) {
        pipe.eosSent = true;
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
      for (const s of this._vozOrden) {
        if ((s.reproducido || s.saltado) && s.inicio < viejo && s.bloques.length) {
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
        }
      }
      this._replayQ.length = 0;
      this._replayProg.length = 0;
      this._replayPendMs = 0;
      this._replayPlayedMs = 0;
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
      if (seg) { seg.bajando = true; seg.bajaDesde = performance.now(); }
      try {
        const r = await fetch(
          `/api/salas/${encodeURIComponent(window.S.sala)}/audio/${seq}`,
          { headers: { Authorization: 'Bearer ' + (window.S.token || '') } });
        if (!r.ok) {
          if (seg) { seg.bajando = false; seg.perdido = true; }
          return;
        }
        const buf = new Uint8Array(await r.arrayBuffer());
        const parsed = parsearArchivoSeg(buf);
        if (!parsed) {
          if (seg) seg.bajando = false;
          return;
        }
        const sg = seg || this._vozSegNuevo(
          parsed.sg.seq, parsed.sg.de, parsed.sg.nombre, parsed.sg.abierto, parsed.sg);
        if (parsed.sg.de && parsed.sg.abierto) this._segPorHablante.set(parsed.sg.de, sg.seq);
        const nuevos = await this._decodificarFramesSeg(parsed.frames, sg);
        for (const b of nuevos) this._insertarBloque(sg, b);
        sg.bajando = false;
        sg.descargado = true;
        if (!parsed.sg.abierto) sg.completo = true;
        if (parsed.sg.durMs) sg.durMs = parsed.sg.durMs;
        if (parsed.sg.cortado) sg.interrumpida = true;
        if (parsed.sg.inicio) sg.inicio = parsed.sg.inicio;
      } catch {
        if (seg) seg.bajando = false;
      } finally {
        this._fetchSegs.delete(seq);
      }
    }

    // Tras una reconexión: pide al servidor el manifiesto de segmentos que
    // se perdieron durante el corte y los descarga en orden
    async _rellenarHuecos(hasta) {
      const sala = (window.S && window.S.sala) || '';
      if (!sala) return;
      const g = (window.S && window.S.grupoActual) || 0;
      try {
        const r = await fetch(
          `/api/salas/${encodeURIComponent(sala)}/audio?desde=${this._ultimoSeg + 1}&g=${g}`,
          { headers: { Authorization: 'Bearer ' + ((window.S && window.S.token) || '') } });
        if (!r.ok) return;
        const man = await r.json();
        for (const meta of man.segmentos || []) {
          const seg = this._vozSegs.get(meta.seq);
          if (seg && (seg.descargado || seg.reproducido)) continue;
          this._vozSegNuevo(meta.seq, meta.de, meta.nombre, false, meta);
          // mis propias frases no se descargan: no se escuchan a uno mismo
          if (meta.de !== this.localParticipant.identity) this._bajarSeg(meta.seq);
        }
        if (man.abierto && !this._vozSegs.get(man.abierto.seq)) {
          this._vozSegNuevo(man.abierto.seq, man.abierto.de, man.abierto.nombre, true, man.abierto);
          this._bajarSeg(man.abierto.seq);
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
      for (const fr of frames) {
        const rc = fr[0];
        if (rc === 0 || fr.length < 2) continue;
        const tx = fr[1] | (fr[2] << 8);
        if (seg && seg.vistos.has(tx)) continue;
        if (rc >= 10 && rc <= 19) {
          ops.push({ tx, fr, nSub: (fr.length > 8 && fr[3] === 0xA5) ? 2 : 1 });
        } else if (rc >= 20 && rc <= 39) {
          const base = rc >= 30 ? rc - 10 : rc;
          const esV2 = fr.length >= 7 && fr[6] === 0x5A;
          const sr = esV2
            ? (base === 21 ? 8000 : (base === 22 ? 12000 : 16000))
            : (base === 21 ? 6000 : (base === 22 ? 8000 : (base === 23 ? 12000 : 16000)));
          const { pcm } = decodificarBloqueADPCM(fr);
          if (pcm.length) out.push({ tx, pcm: remuestrearA(rsDe(sr), pcm, sr, ctxRate) });
        } else if (rc === 1 || rc === 2) {
          const sr = rc === 1 ? 8000 : 12000;
          const pcm = new Float32Array(fr.length - 1);
          for (let i = 1; i < fr.length; i++) pcm[i - 1] = ulawDecodeTable[fr[i]];
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
            if (o.nSub === 2) {
              const len1 = fr[4] | (fr[5] << 8);
              const off1 = 6;
              if (off1 + len1 <= fr.length && len1 > 0) {
                dec.decode(new window.EncodedAudioChunk({
                  type: 'key', timestamp: ts, duration: 20000,
                  data: fr.subarray(off1, off1 + len1),
                }));
                ts += 20000;
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
                }
              }
            } else {
              dec.decode(new window.EncodedAudioChunk({
                type: 'key', timestamp: ts, duration: 20000, data: fr.subarray(3),
              }));
              ts += 20000;
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
          const pcm = new Float32Array(total);
          let w = 0;
          for (const p of partes) { pcm.set(p, w); w += p.length; }
          out.push({ tx: o.tx, pcm: remuestrearA(rsDe(48000), pcm, 48000, ctxRate) });
        }
      }
      return out;
    }

    // ---------- re-escucha de notas de voz ----------
    _encolarReplay(seq, bloques) {
      if (!bloques.length) return false;
      const rate = (this._vozPipe && this._vozPipe.ctxRate) || this._vozRate;
      const msTotal = bloques.reduce((m, b) => m + (b.pcm.length / rate) * 1000, 0);
      this._replayQ.push({ seq, bloques, alimentado: 0, msTotal });
      const base = this._replayProg.length
        ? this._replayProg[this._replayProg.length - 1].finMs
        : this._replayPlayedMs;
      this._replayProg.push({ seq, msTotal, finMs: Math.max(base, this._replayPlayedMs) + msTotal });
      this._programarFeedOn();
      return true;
    }

    reproducirSeg(seq) {
      const seg = this._vozSegs.get(seq);
      if (!seg || !seg.bloques.length) return false;
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
      return this._encolarReplay(seq || parsed.sg.seq || ('r' + Date.now()), bl);
    }

    datosSeg(seq) {
      const s = this._vozSegs.get(seq);
      return s ? {
        seq: s.seq, de: s.de, nombre: s.nombre, durMs: s.durMs,
        inicio: s.inicio, interrumpida: s.interrumpida, raw: s.raw,
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
        // Watchdog Make-Before-Break: si el WiFi del vecino congeló el socket TCP
        // más de 4.5s sin recibir respuesta o atascó la cola de subida (>14 KB),
        // abrir un socket nuevo en paralelo de inmediato sin esperar 10-15s al OS.
        if ((now - (this._lastRxAt || now)) > 4500 || this._ws.bufferedAmount > 14 * 1024) {
          this._lastRxAt = now;
          if (typeof this._reemplazarSocketCongelado === 'function') {
            this._reemplazarSocketCongelado();
            return;
          }
        }
        if (this._ws.bufferedAmount > 6144) {
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
          if (typeof this._reemplazarSocketCongelado === 'function') {
            this._reemplazarSocketCongelado();
          }
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
          // Tras una reconexión: reclamar el piso (si seguía pisado) y luego
          // soltar en ráfaga la voz encolada durante el corte
          if (this._quieroPiso) {
            this._enviarJson({ t: 'piso_tomar' });
            setTimeout(() => this._drenarTx(), 350);
          } else {
            this._programarFlushTx();
          }
          this.emit(RoomEvent.ConnectionStateChanged, 'connected');
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
      this._quieroPiso = false;
      this._tengoPiso = false;
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
          this.emit('seg_ini', this._segMeta(seg));
          break;
        }

        case 'seg_fin': {
          // La frase terminó (EOS): el segmento es una nota de voz cerrada
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
            // Huecos detectados en vivo: descargar el segmento completo para
            // rellenar las tramas que el micro-corte se llevó
            if (seg.huecos && !seg.descargado) this._bajarSeg(m.seq);
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

        case 'piso_ok':
          this._tengoPiso = true;
          this.emit('piso', { estado: 'mio' });
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

        // 1. Trama Opus nativa ultraligera (14 / 22 / 32 kbps)
        if (rateCode >= 10 && rateCode <= 19) {
          if (!SOPORTE_OPUS_RX || typeof window.AudioDecoder !== 'function') return;
          try {
            if (!pipe.opusDecoder || pipe.opusDecoder.state === 'closed') {
              pipe.opusDecoder = new window.AudioDecoder({
                output: (audioData) => {
                  const sRate = audioData.sampleRate || 48000;
                  const pcm = extraerFloat32DeAudioData(audioData);
                  const seqOut = pipe._pendingOpusSeq;
                  pipe._pendingOpusSeq = -1;
                  audioData.close();
                  this._empujarMuestrasRemotas(pipe, pcm, sRate, fromId, ftipo, seqOut, payload);
                },
                error: () => {},
              });
              pipe.opusDecoder.configure({
                codec: 'opus',
                sampleRate: 48000,
                numberOfChannels: 1,
              });
            }
            // Formato v2 dual (2 sub-tramas Opus de 20 ms con secuencia):
            // payload = [rateCode, seqLo, seqHi, 0xA5, len1Lo, len1Hi, ...b1..., len2Lo, len2Hi, ...b2...]
            if (payload.length > 8 && payload[3] === 0xA5) {
              const seq = payload[1] | (payload[2] << 8);
              const len1 = payload[4] | (payload[5] << 8);
              const off1 = 6;
              if (off1 + len1 <= payload.length && len1 > 0) {
                const b1 = payload.subarray(off1, off1 + len1);
                pipe._pendingOpusSeq = seq;
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

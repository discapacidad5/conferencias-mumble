/* ============================================================================
 * Motor Mumble + WebSocket HTTPS/443 para Conferencias en Conexiones Lentas
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

  // Codifica un bloque Float32 en IMA-ADPCM con cabecera de estado [predLo, predHi, stepIdx, 0]
  // y filtro de pre-énfasis (mejora la nitidez de consonantes y reduce ruido de cuantización).
  function codificarBloqueADPCM(samples, state, rateCode) {
    const n = samples.length;
    const outBytes = Math.ceil(n / 2);
    const pkt = new Uint8Array(6 + outBytes);
    pkt[0] = FRAME_AUDIO;
    pkt[1] = rateCode;

    let pred = state.pred | 0;
    let idx = state.idx | 0;
    let prevIn = state.prevIn || 0;

    // Guardar estado inicial del bloque para que cada paquete sea 100% autónomo ante pérdidas
    pkt[2] = pred & 0xff;
    pkt[3] = (pred >> 8) & 0xff;
    pkt[4] = idx & 0xff;
    pkt[5] = 0;

    let bytePos = 6;
    let highNibble = false;
    let curByte = 0;

    for (let i = 0; i < n; i++) {
      const x = samples[i];
      // Pre-énfasis suave (0.42) para destacar agudos de la voz antes de cuantizar
      const emph = Math.max(-1, Math.min(1, x - 0.42 * prevIn));
      prevIn = x;
      const val = (emph * 32767) | 0;

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
    state.prevIn = prevIn;
    return pkt;
  }

  function decodificarBloqueADPCM(payload, deemphState) {
    if (payload.length < 5) return new Float32Array(0);
    // payload[0] = rateCode, payload[1..2] = pred (int16 LE), payload[3] = stepIdx, payload[4] = reserved
    let pred = payload[1] | (payload[2] << 8);
    if (pred & 0x8000) pred -= 0x10000;
    let idx = payload[3];
    if (idx < 0) idx = 0;
    else if (idx > 88) idx = 88;

    const dataBytes = payload.length - 5;
    const numSamples = dataBytes * 2;
    const out = new Float32Array(numSamples);
    let yPrev = deemphState.yPrev || 0;
    let outIdx = 0;

    for (let i = 5; i < payload.length; i++) {
      const b = payload[i];
      for (let s = 0; s < 2; s++) {
        const nibble = s === 0 ? (b & 0x0f) : ((b >> 4) & 0x0f);
        let step = ADPCM_STEP_TABLE[idx];
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

        // De-énfasis complementario (suaviza el grano de cuantización y restaura el timbre natural)
        const rawFloat = pred / 32768.0;
        const y = Math.max(-1, Math.min(1, rawFloat + 0.42 * yPrev));
        yPrev = y;
        out[outIdx++] = y;
      }
    }
    deemphState.yPrev = yPrev;
    return out;
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

  // Extrae muestras Float32 de un objeto WebCodecs AudioData (compatible con f32 y s16)
  function extraerFloat32DeAudioData(audioData) {
    const n = audioData.numberOfFrames;
    const fmt = audioData.format || 'f32-planar';
    try {
      const out = new Float32Array(n);
      audioData.copyTo(out, { planeIndex: 0, format: 'f32-planar' });
      return out;
    } catch {
      if (fmt.startsWith('s16')) {
        const s16 = new Int16Array(n * (audioData.numberOfChannels || 1));
        audioData.copyTo(s16, { planeIndex: 0 });
        const out = new Float32Array(n);
        const step = fmt.includes('planar') ? 1 : (audioData.numberOfChannels || 1);
        for (let i = 0; i < n; i++) out[i] = s16[i * step] / 32768.0;
        return out;
      }
      const out = new Float32Array(n);
      audioData.copyTo(out, { planeIndex: 0 });
      return out;
    }
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
        this._iniciarEnvioVozMumble(mediaStreamTrack, pub, opts);
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

    _iniciarEnvioVozMumble(mediaStreamTrack, pub, opts) {
      let maxBr = (opts && opts.audioPreset && opts.audioPreset.maxBitrate) || 18000;
      let actx = null;
      let proc = null;
      let srcNode = null;
      let opusEncoder = null;
      let opusListo = false;
      let opusTimestampUs = 0;

      // Estado ADPCM y filtros anti-aliasing para respaldo universal
      const adpcmState = { pred: 0, idx: 0, prevIn: 0 };
      let filtroAA = crearFiltroPasaBajos(48000, 3600);

      // Configurar / reconfigurar codificador Opus nativo en caliente
      const configurarOpus = (nuevoBr) => {
        maxBr = nuevoBr || 18000;
        const cutoff = maxBr <= 11000 ? 2700 : (maxBr <= 20000 ? 3700 : 5400);
        filtroAA = crearFiltroPasaBajos(48000, cutoff);
        if (!SOPORTE_OPUS_TX || typeof window.AudioEncoder !== 'function') return;
        try {
          if (!opusEncoder || opusEncoder.state === 'closed') {
            opusEncoder = new window.AudioEncoder({
              output: (chunk) => {
                if (!this._room || !this._room._ws || this._room._ws.readyState !== WebSocket.OPEN) return;
                const n = chunk.byteLength;
                if (n <= 0) return;
                const rateCode = maxBr <= 11000 ? 10 : (maxBr <= 20000 ? 11 : 12);
                const pkt = new Uint8Array(2 + n);
                pkt[0] = FRAME_AUDIO;
                pkt[1] = rateCode;
                chunk.copyTo(pkt.subarray(2));
                opusListo = true;
                try { this._room._ws.send(pkt); } catch {}
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
                frameDuration: 40000,
                complexity: 5,
                useinbandfec: true,
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
      this._actualizarBitrateMic = (nuevosOpts) => {
        const br = (nuevosOpts && nuevosOpts.audioPreset && nuevosOpts.audioPreset.maxBitrate) || 18000;
        if (br !== maxBr) configurarOpus(br);
      };

      // Enviar un bloque de 40 ms (1920 muestras @ 48 kHz) por Opus y/o ADPCM
      const enviarTrama40ms = (frame48k) => {
        if (!this._room || !this._room._ws || this._room._ws.readyState !== WebSocket.OPEN) return;
        if (this._room._ws.bufferedAmount > 36 * 1024) return;

        let enviadoOpus = false;
        if (opusEncoder && opusEncoder.state === 'configured' && opusListo) {
          try {
            const ad = new window.AudioData({
              format: 'f32-planar',
              sampleRate: 48000,
              numberOfFrames: 1920,
              numberOfChannels: 1,
              timestamp: opusTimestampUs,
              data: frame48k,
            });
            opusTimestampUs += 40000;
            opusEncoder.encode(ad);
            ad.close();
            enviadoOpus = true;
          } catch {
            enviadoOpus = false;
          }
        }

        // Si el navegador no tiene Opus o en la sala hay algún oyente sin Opus,
        // enviamos la trama ADPCM filtrada con anti-aliasing (24/32/48 kbps)
        const necesitaAdpcm = !enviadoOpus || !!this._room._haySinOpus;
        if (necesitaAdpcm) {
          // Factor exacto desde 48000 Hz: 8 -> 6000 Hz (24 kbps), 6 -> 8000 Hz (32 kbps), 4 -> 12000 Hz (48 kbps)
          const decim = maxBr <= 11000 ? 8 : (maxBr <= 20000 ? 6 : 4);
          const baseCode = maxBr <= 11000 ? 21 : (maxBr <= 20000 ? 22 : 23);
          const rateCode = enviadoOpus ? (baseCode + 10) : baseCode; // 31..33 = respaldo simultáneo; 21..23 = primario
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
          const pkt = codificarBloqueADPCM(sub, adpcmState, rateCode);
          try { this._room._ws.send(pkt); } catch {}
        }
      };

      try {
        actx = new (window.AudioContext || window.webkitAudioContext)();
        const ms = new MediaStream([mediaStreamTrack]);
        srcNode = actx.createMediaStreamSource(ms);
        proc = actx.createScriptProcessor(2048, 1, 1);
        const inRate = actx.sampleRate || 48000;
        const stepIn = inRate / 48000;
        const filtroHP = crearFiltroPasaAltos85Hz(inRate);

        // Acumulador de 40 ms exactos (1920 muestras @ 48 kHz) con interpolación lineal continua
        const frameBuf = new Float32Array(1920);
        let frameFill = 0;
        let inPhase = 0;
        let lastInSample = 0;

        // Estado VAD con pre-roll de 40 ms, piso de ruido adaptativo e histéresis suave
        let prevFrame48k = new Float32Array(1920);
        let tienePrevFrame = false;
        let hablandoActivo = false;
        let silencioCola = 0;
        let noiseFloor = 0.0025;

        proc.onaudioprocess = (ev) => {
          if (pub.isMuted || !this._room || !this._room._ws || this._room._ws.readyState !== WebSocket.OPEN) {
            hablandoActivo = false;
            silencioCola = 0;
            return;
          }
          const rawIn = ev.inputBuffer.getChannelData(0);
          const nIn = rawIn.length;
          if (nIn === 0) return;

          // Filtrar retumbo (<85 Hz) y remuestrear con fase continua a 48000 Hz
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
              // Calcular energía RMS del bloque de 40 ms
              let sum = 0;
              for (let j = 0; j < 1920; j += 2) {
                const v = frameBuf[j];
                sum += v * v;
              }
              const rms = Math.sqrt(sum / 960);

              // Actualizar piso de ruido suavemente durante silencio
              if (!hablandoActivo && rms < noiseFloor * 1.8) {
                noiseFloor = Math.max(0.0012, Math.min(0.0055, noiseFloor * 0.95 + rms * 0.05));
              }
              const umbralAbrir = Math.max(0.0055, noiseFloor * 2.5);
              const umbralMantener = Math.max(0.0032, noiseFloor * 1.55);

              if (rms >= (hablandoActivo ? umbralMantener : umbralAbrir)) {
                if (!hablandoActivo) {
                  hablandoActivo = true;
                  // Enviar pre-roll de 40 ms con fade-in de 4 ms para no cortar la primera consonante
                  if (tienePrevFrame) {
                    const pre = new Float32Array(prevFrame48k);
                    for (let k = 0; k < 192; k++) pre[k] *= (k / 192);
                    enviarTrama40ms(pre);
                  }
                }
                silencioCola = 10; // mantener 400 ms de cola entre palabras para no entrecortar frases
                this._room._marcarHablandoLocal(true);
                enviarTrama40ms(frameBuf);
              } else if (silencioCola > 0) {
                silencioCola--;
                if (silencioCola === 0) {
                  // Última trama de cola: aplicar fade-out suave a cero para evitar clic al callar
                  const tail = new Float32Array(frameBuf);
                  for (let k = 0; k < 1920; k++) tail[k] *= (1 - k / 1920);
                  enviarTrama40ms(tail);
                  hablandoActivo = false;
                  this._room._marcarHablandoLocal(false);
                } else {
                  enviarTrama40ms(frameBuf);
                }
              } else {
                hablandoActivo = false;
                this._room._marcarHablandoLocal(false);
              }

              prevFrame48k.set(frameBuf);
              tienePrevFrame = true;
            }
          }
          inPhase -= nIn;
          lastInSample = filtered[nIn - 1];
        };

        srcNode.connect(proc);
        proc.connect(actx.destination);
      } catch (e) {
        console.warn('Error iniciando codificador de voz Mumble:', e);
      }

      this._micCleanup = () => {
        this._actualizarBitrateMic = null;
        try { if (opusEncoder && opusEncoder.state !== 'closed') opusEncoder.close(); } catch {}
        opusEncoder = null;
        try { if (proc) proc.disconnect(); } catch {}
        try { if (srcNode) srcNode.disconnect(); } catch {}
        try { if (actx) actx.close(); } catch {}
        this._room._marcarHablandoLocal(false);
      };
    }

    _iniciarEnvioAudioCompartido(mediaStreamTrack, pub, name) {
      let actx = null;
      let proc = null;
      let srcNode = null;
      const adpcmState = { pred: 0, idx: 0, prevIn: 0 };
      const filtroAA = crearFiltroPasaBajos(48000, 5200);
      try {
        this._room._ws.send(JSON.stringify({ t: 'audio_share_meta', activo: true, nombre: name }));
        actx = new (window.AudioContext || window.webkitAudioContext)();
        const ms = new MediaStream([mediaStreamTrack]);
        srcNode = actx.createMediaStreamSource(ms);
        proc = actx.createScriptProcessor(4096, 1, 1);
        const inRate = actx.sampleRate || 48000;
        const targetRate = 12000;
        const ratio = inRate / targetRate;

        proc.onaudioprocess = (ev) => {
          if (pub.isMuted || !this._room || !this._room._ws || this._room._ws.readyState !== WebSocket.OPEN) return;
          if (this._room._ws.bufferedAmount > 64 * 1024) return;
          const input = ev.inputBuffer.getChannelData(0);
          let sum = 0;
          for (let i = 0; i < input.length; i += 4) sum += input[i] * input[i];
          if (Math.sqrt(sum / (input.length / 4)) < 0.0018) return;

          const outLen = Math.floor(input.length / ratio);
          const sub = new Float32Array(outLen);
          for (let i = 0; i < outLen; i++) {
            const idx = Math.min(input.length - 1, Math.floor(i * ratio));
            sub[i] = filtroAA(input[idx]);
          }
          const pkt = codificarBloqueADPCM(sub, adpcmState, 23);
          pkt[0] = FRAME_AUDIO_SHARE;
          try { this._room._ws.send(pkt); } catch {}
        };
        srcNode.connect(proc);
        proc.connect(actx.destination);
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
    }

    _asegurarRxAudioCtx() {
      if (!this._rxAudioCtx || this._rxAudioCtx.state === 'closed') {
        this._rxAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
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
      // Evaluación inicial inmediata según el tipo de red móvil reportado por el navegador
      this._evaluarCalidadRed();
      this.emit(RoomEvent.ConnectionQualityChanged, this._calidadActual, this.localParticipant);

      const enviarPing = () => {
        if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
        if (this._ws.bufferedAmount > 16384) {
          this._evaluarCalidadRed(420);
        }
        try {
          this._ws.send(JSON.stringify({ t: 'ping_net', ts: Math.round(performance.now()) }));
        } catch {}
      };
      setTimeout(enviarPing, 600);
      this._pingTimer = setInterval(enviarPing, 3200);

      const navConn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (navConn && typeof navConn.addEventListener === 'function') {
        this._onNetChange = () => this._evaluarCalidadRed();
        navConn.addEventListener('change', this._onNetChange);
      }
    }

    async connect(baseUrl, token) {
      await promesaDeteccionOpus;

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
      const wsUrl = `${wsBase}/api/salas/${encodeURIComponent(sala)}/media?token=${encodeURIComponent(token)}&opus=${SOPORTE_OPUS_RX ? 1 : 0}`;

      await new Promise((resolve, reject) => {
        let conectado = false;
        const ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';
        this._ws = ws;

        const timeout = setTimeout(() => {
          if (!conectado) {
            try { ws.close(); } catch {}
            reject(new Error('Tiempo agotado conectando al canal de voz Mumble'));
          }
        }, 12000);

        ws.onopen = () => {
          conectado = true;
          clearTimeout(timeout);
          this._speakerTimer = setInterval(() => this._actualizarSpeakers(), 300);
          this._iniciarMonitorRed();
          this._enviarEstadoMedia();
          this.emit(RoomEvent.ConnectionStateChanged, 'connected');
          resolve();
        };

        ws.onerror = () => {
          if (!conectado) {
            clearTimeout(timeout);
            reject(new Error('No se pudo abrir la conexión WebSocket HTTPS'));
          }
        };

        ws.onmessage = (ev) => {
          if (typeof ev.data === 'string') {
            this._manejarTexto(ev.data);
          } else if (ev.data instanceof ArrayBuffer) {
            this._manejarBinario(new Uint8Array(ev.data));
          }
        };

        ws.onclose = (ev) => {
          clearTimeout(timeout);
          if (this._speakerTimer) {
            clearInterval(this._speakerTimer);
            this._speakerTimer = null;
          }
          if (this._pingTimer) {
            clearInterval(this._pingTimer);
            this._pingTimer = null;
          }
          if (!conectado) {
            reject(new Error('Conexión cerrada antes de iniciar'));
            return;
          }
          if (ev.code === 4002 || ev.reason === 'DUPLICATE_IDENTITY') {
            this.disconnectReason = DisconnectReason.DUPLICATE_IDENTITY;
          }
          this.emit(RoomEvent.Disconnected, this.disconnectReason);
        };
      });
    }

    async disconnect() {
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
      try { if (pipe.proc) pipe.proc.disconnect(); } catch {}
    }

    // Crea un pipeline receptor continuo basado en un Ring Buffer circular con
    // pre-buffering adaptativo al jitter (90–240 ms) e interpolación continua
    // entre paquetes. Elimina al 100% el ruido de bordes ("basurita") y los
    // micro-cortes de createBufferSource() por paquete.
    _asegurarAudioRemoto(p, source, nombre) {
      let pub = p.pubs.get(source);
      if (pub) return pub;

      const ctx = this._asegurarRxAudioCtx();
      const ctxRate = ctx.sampleRate || 48000;
      const dest = ctx.createMediaStreamDestination();
      const msTrack = dest.stream.getAudioTracks()[0];
      const track = new MediaTrack('audio', source, msTrack);
      const sid = 'TR_' + source + '_' + p.identity;
      pub = new TrackPublication(source, track, sid, nombre);
      p.pubs.set(source, pub);

      // Ring buffer de 2.5 segundos a la frecuencia nativa del AudioContext
      const cap = Math.ceil(ctxRate * 2.5);
      const pipe = {
        ctx,
        ctxRate,
        dest,
        pub,
        p,
        ring: new Float32Array(cap),
        cap,
        writePos: 0,
        readPos: 0,
        available: 0,
        playing: false,
        fadeInPos: 0,
        fadeInLen: Math.ceil(ctxRate * 0.006), // 6 ms fade-in suave al arrancar frase
        lastOutSample: 0,
        underrunSamples: 0,
        // Estado de remuestreo continuo entre paquetes consecutivos
        rxPhase: 0,
        rxLastInSample: 0,
        rxHasLast: false,
        // Estado de jitter adaptativo
        lastArrivalMs: 0,
        jitterMs: 25,
        targetPrebuffer: Math.ceil(ctxRate * 0.11), // 110 ms inicial
        maxBuffer: Math.ceil(ctxRate * 0.42),       // 420 ms tope antes de recortar latencia
        deemphState: { yPrev: 0 },
        opusDecoder: null,
        opusTimestampUs: 0,
        proc: null,
      };

      const proc = ctx.createScriptProcessor(1024, 1, 1);
      proc.onaudioprocess = (ev) => {
        const out = ev.outputBuffer.getChannelData(0);
        const n = out.length;

        if (!pipe.playing) {
          if (pipe.available >= pipe.targetPrebuffer) {
            pipe.playing = true;
            pipe.fadeInPos = 0;
            pipe.underrunSamples = 0;
          } else {
            // Todavía acumulando colchón inicial de jitter
            for (let i = 0; i < n; i++) out[i] = 0;
            return;
          }
        }

        const ring = pipe.ring;
        const capLocal = pipe.cap;
        for (let i = 0; i < n; i++) {
          if (pipe.available > 0) {
            let s = ring[pipe.readPos];
            pipe.readPos = (pipe.readPos + 1) % capLocal;
            pipe.available--;
            if (pipe.fadeInPos < pipe.fadeInLen) {
              s *= (pipe.fadeInPos / pipe.fadeInLen);
              pipe.fadeInPos++;
            }
            out[i] = s;
            pipe.lastOutSample = s;
            pipe.underrunSamples = 0;
          } else {
            // Si falta un paquete por retraso momentáneo en 2G/3G, decaer suavemente
            // a cero en lugar de producir un escalón brusco (clic)
            pipe.lastOutSample *= 0.965;
            if (Math.abs(pipe.lastOutSample) < 0.0001) pipe.lastOutSample = 0;
            out[i] = pipe.lastOutSample;
            pipe.underrunSamples++;
            // Tras ~55 ms sin datos, volver a modo pre-buffer para la siguiente frase
            if (pipe.underrunSamples > pipe.ctxRate * 0.055) {
              pipe.playing = false;
              for (let k = i + 1; k < n; k++) out[k] = 0;
              break;
            }
          }
        }
      };

      proc.connect(dest);
      pipe.proc = proc;
      this._rxPipelines.set(sid, pipe);
      this.emit(RoomEvent.TrackSubscribed, track, pub, p);
      return pub;
    }

    // Remuestrea continuamente y empuja un bloque decodificado al Ring Buffer
    // adaptando el colchón de jitter según la estabilidad de llegada de los paquetes.
    _empujarMuestrasRemotas(pipe, samples, inRate, fromId, ftipo) {
      if (!samples || samples.length === 0) return;
      const nowMs = performance.now();
      const durMs = (samples.length / inRate) * 1000;
      if (pipe.lastArrivalMs > 0) {
        const deltaMs = nowMs - pipe.lastArrivalMs;
        if (deltaMs < 350) {
          const jit = Math.abs(deltaMs - durMs);
          pipe.jitterMs = pipe.jitterMs * 0.88 + jit * 0.12;
          // Colchón adaptativo entre 95 ms (red limpia) y 240 ms (red móvil con ráfagas TCP)
          const targetMs = Math.max(95, Math.min(240, 85 + pipe.jitterMs * 2.2));
          pipe.targetPrebuffer = Math.ceil(pipe.ctxRate * (targetMs / 1000));
          pipe.maxBuffer = pipe.targetPrebuffer + Math.ceil(pipe.ctxRate * 0.28);
        } else {
          // Nueva frase tras silencio: reiniciar interpolador
          pipe.rxHasLast = false;
          pipe.rxPhase = 0;
        }
      }
      pipe.lastArrivalMs = nowMs;

      // Si se acumularon demasiados paquetes por un atasco TCP previo, hacer crossfade
      // suave descartando el exceso más antiguo para mantener tiempo real sin clics
      if (pipe.available > pipe.maxBuffer) {
        const drop = pipe.available - pipe.targetPrebuffer;
        pipe.readPos = (pipe.readPos + drop) % pipe.cap;
        pipe.available -= drop;
        pipe.fadeInPos = 0;
      }

      const step = inRate / pipe.ctxRate;
      const nIn = samples.length;
      const ring = pipe.ring;
      const cap = pipe.cap;
      let sum = 0;

      if (!pipe.rxHasLast) {
        pipe.rxLastInSample = samples[0];
        pipe.rxHasLast = true;
        pipe.rxPhase = 0;
      }

      while (pipe.rxPhase < nIn) {
        const idx = pipe.rxPhase | 0;
        const frac = pipe.rxPhase - idx;
        const s0 = idx === 0 ? pipe.rxLastInSample : samples[idx - 1];
        const s1 = samples[idx];
        const val = s0 + frac * (s1 - s0);

        if (pipe.available < cap) {
          ring[pipe.writePos] = val;
          pipe.writePos = (pipe.writePos + 1) % cap;
          pipe.available++;
        }
        pipe.rxPhase += step;
      }
      pipe.rxPhase -= nIn;
      pipe.rxLastInSample = samples[nIn - 1];

      for (let i = 0; i < nIn; i += 4) {
        sum += samples[i] * samples[i];
      }
      const rms = Math.sqrt(sum / Math.max(1, Math.ceil(nIn / 4)));
      if (ftipo === FRAME_AUDIO && rms > 0.008) {
        this._speakers.set(fromId, Date.now() + 650);
        this._actualizarSpeakers();
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
        if (payload.length < 2) return;
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

        // 1. Trama Opus nativa ultraligera (10 kbps / 18 kbps / 28 kbps)
        if (rateCode >= 10 && rateCode <= 19) {
          if (!SOPORTE_OPUS_RX || typeof window.AudioDecoder !== 'function') return;
          try {
            if (!pipe.opusDecoder || pipe.opusDecoder.state === 'closed') {
              pipe.opusDecoder = new window.AudioDecoder({
                output: (audioData) => {
                  const sRate = audioData.sampleRate || 48000;
                  const pcm = extraerFloat32DeAudioData(audioData);
                  audioData.close();
                  this._empujarMuestrasRemotas(pipe, pcm, sRate, fromId, ftipo);
                },
                error: () => {},
              });
              pipe.opusDecoder.configure({
                codec: 'opus',
                sampleRate: 48000,
                numberOfChannels: 1,
              });
            }
            const opusBytes = payload.subarray(1);
            const chunk = new window.EncodedAudioChunk({
              type: 'key',
              timestamp: pipe.opusTimestampUs,
              duration: 40000,
              data: opusBytes,
            });
            pipe.opusTimestampUs += 40000;
            pipe.opusDecoder.decode(chunk);
          } catch {}
          return;
        }

        // 2. Trama IMA-ADPCM de 4 bits con pre/de-énfasis (24 kbps / 32 kbps / 48 kbps)
        if (rateCode >= 20 && rateCode <= 39) {
          const baseCode = rateCode >= 30 ? (rateCode - 10) : rateCode;
          const sampleRate = baseCode === 21 ? 6000 : (baseCode === 22 ? 8000 : (baseCode === 23 ? 12000 : 16000));
          const pcm = decodificarBloqueADPCM(payload, pipe.deemphState);
          this._empujarMuestrasRemotas(pipe, pcm, sampleRate, fromId, ftipo);
          return;
        }

        // 3. Retrocompatibilidad con tramas µ-law antiguas (rateCode 1 = 8kHz, 2 = 12kHz)
        const sampleRate = rateCode === 1 ? 8000 : 12000;
        const samples = payload.subarray(1);
        const pcm = new Float32Array(samples.length);
        for (let i = 0; i < samples.length; i++) {
          pcm[i] = ulawDecodeTable[samples[i]];
        }
        this._empujarMuestrasRemotas(pipe, pcm, sampleRate, fromId, ftipo);
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

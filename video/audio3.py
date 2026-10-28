# Track 2 for the news-open film (120 BPM, so cuts land on beats): pulsing minor bed -> drop at 12.0 into a bright D-major house groove with a lead hook, piano-style offbeat chords, shaker and a syncopated bass -> feature stabs -> resolve. Pure numpy, nothing sampled.
import numpy as np, wave, sys
SR = 44100; DUR = 30.0; N = int(SR * DUR); BEAT = 0.5
t = np.arange(N) / SR
rng = np.random.default_rng(11)
def put(buf, sig, at, gain=1.0):
    i0 = int(at * SR)
    if i0 >= N: return
    n = min(len(sig), N - i0); buf[i0:i0 + n] += sig[:n] * gain
def tt(d): return np.arange(int(d * SR)) / SR
def lp(x, k):  # crude low-pass: moving average
    return np.convolve(x, np.ones(k) / k, mode="same")
def hp(x, k): return x - lp(x, k)

def kick(g=1.0):
    x = tt(0.42); f = 45 + 110 * np.exp(-x * 28)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return (np.sin(ph) * np.exp(-x * 8) + 0.25 * np.sin(ph * 2) * np.exp(-x * 30) + 0.4 * np.exp(-x * 400) * rng.standard_normal(len(x))) * g
def clap(g=1.0):
    x = tt(0.3); n = rng.standard_normal(len(x))
    n = hp(lp(n, 3), 40)
    env = np.exp(-x * 22) + 0.7 * np.exp(-np.maximum(0, x - 0.012) * 30) * (x > 0.012) + 0.6 * np.exp(-np.maximum(0, x - 0.024) * 28) * (x > 0.024)
    return n * env * 1.6 * g
def hat(g=1.0, open_=False):
    x = tt(0.25 if open_ else 0.06); n = hp(rng.standard_normal(len(x)), 6)
    return n * np.exp(-x * (14 if open_ else 80)) * g
def snare(g=1.0):
    x = tt(0.22); n = hp(rng.standard_normal(len(x)), 8)
    return (n * np.exp(-x * 24) * 0.9 + np.sin(2 * np.pi * 190 * x) * np.exp(-x * 30) * 0.5) * g
def bass(f, d, g=1.0):
    x = tt(d); s = np.sin(2 * np.pi * f * x) + 0.45 * np.sin(2 * np.pi * f * 2 * x) + 0.2 * np.sin(2 * np.pi * f * 3 * x)
    env = np.minimum(1, x / 0.006) * np.exp(-x * 3.2)
    return s * env * g
def pluck(f, d=0.5, g=1.0):
    x = tt(d); s = sum(np.sin(2 * np.pi * f * k * x) / k for k in (1, 2, 3, 4, 5)) * 0.5
    return s * np.minimum(1, x / 0.003) * np.exp(-x * 11) * g
def stab(freqs, d=0.55, g=1.0):
    x = tt(d); s = sum(np.sin(2 * np.pi * f * x) + 0.5 * np.sin(2 * np.pi * f * 2.003 * x) for f in freqs) / len(freqs)
    return lp(s, 4) * np.minimum(1, x / 0.004) * np.exp(-x * 7) * g
def bell(f, d=2.5, g=1.0, decay=2.2):
    x = tt(d); s = np.sin(2 * np.pi * f * x) + 0.4 * np.sin(2 * np.pi * f * 2.76 * x) + 0.2 * np.sin(2 * np.pi * f * 5.4 * x)
    return s * np.minimum(1, x / 0.004) * np.exp(-x * decay) * g
def whoosh(d=0.9, g=1.0, up=True):
    x = tt(d); n = lp(rng.standard_normal(len(x)), 40) + 0.5 * hp(rng.standard_normal(len(x)), 12)
    shape = np.sin(np.pi * np.clip(x / d, 0, 1)) ** 2
    return n * shape * g * 2.2
def riser(a, b, g=1.0):
    d = b - a; x = tt(d); k = x / d
    n = hp(rng.standard_normal(len(x)), 10) * (k ** 2.2)
    f = 180 * (8 ** k); s = np.sin(2 * np.pi * np.cumsum(f) / SR) * (k ** 1.6) * 0.5
    return (n * 0.5 + s) * g


def mf(m): return 440.0 * 2 ** ((m - 69) / 12)
def saw(f, x, detune=0.0): return 2 * ((f * (1 + detune) * x) % 1.0) - 1
def supersaw(f, d, g=1.0, cut=40):
    x = tt(d); s = sum(saw(f, x, dt) for dt in (-0.012, -0.006, 0.0, 0.006, 0.012)) / 5
    return lp(s, cut) * np.minimum(1, x / 0.02) * np.minimum(1, (d - x) / 0.08) * g
def lead(f, d, g=1.0):
    x = tt(d); s = 0.6 * saw(f, x) + 0.4 * np.sign(np.sin(2 * np.pi * f * x))
    s = lp(s, 6) + 0.25 * np.sin(2 * np.pi * f * x) * np.sin(2 * np.pi * 5.5 * x + 1) * 0.0
    return s * np.minimum(1, x / 0.006) * np.exp(-x * 3.0) * np.minimum(1, (d - x) / 0.04) * g
def piano(f, d=0.5, g=1.0):
    x = tt(d); s = sum(np.sin(2 * np.pi * f * k * x) * (0.6 ** k) for k in (1, 2, 3, 4)) + 0.15 * np.sin(2 * np.pi * f * 5.01 * x)
    return s * np.minimum(1, x / 0.003) * np.exp(-x * 9) * g
def sub(f, d, g=1.0):
    x = tt(d); s = np.sin(2 * np.pi * f * x) + 0.3 * np.sin(2 * np.pi * f * 2 * x) + 0.12 * lp(saw(f, x), 30)
    return s * np.minimum(1, x / 0.008) * np.exp(-x * 5.5) * g
def shaker(g=1.0):
    x = tt(0.07); return hp(rng.standard_normal(len(x)), 4) * np.exp(-x * 60) * g

DROP = 12.0
CHORDS = [("D", 38, [62, 66, 69]), ("A", 45, [61, 64, 69]), ("Bm", 47, [62, 66, 71]), ("G", 43, [62, 67, 71])]
HOOK = [  # per bar: (beat, midi, beats)
    [(0, 78, 1), (1, 81, .5), (1.5, 78, .5), (2, 74, 1), (3, 76, 1)],
    [(0, 76, 1), (1, 81, .5), (1.5, 76, .5), (2, 73, 1), (3, 76, 1)],
    [(0, 74, 1), (1, 78, .5), (1.5, 74, .5), (2, 71, 1), (3, 74, 1)],
    [(0, 71, 1), (1, 74, .5), (1.5, 71, .5), (2, 67, 1), (3, 69, 1)],
]
drums = np.zeros(N); music = np.zeros(N); fx = np.zeros(N); kick_times = []

# ── news bed (0-12): a tense B-minor sixteenth-note sequence that opens up, ticking hats, a growing pulse, data blips, a riser, a snare roll
seq = [47, 54, 59, 62, 59, 54, 59, 62]   # B2 F#3 B3 D4 ...
for s_ in range(int(DROP / (BEAT / 4))):
    at = s_ * BEAT / 4; k = min(1.0, at / DROP)
    m = seq[s_ % 8] + (12 if (s_ // 32) % 2 else 0)
    put(music, pluck(mf(m), 0.22, (0.10 + 0.18 * k) * (1.0 if s_ % 4 == 0 else 0.7)), at)
music += np.sin(2 * np.pi * mf(35) * t) * (t < DROP) * np.minimum(1, t / 2.5) * (0.08 + 0.10 * np.clip(t / DROP, 0, 1))
for i in range(int(DROP / BEAT)):
    at = i * BEAT
    put(drums, hat(0.07 + 0.09 * min(1, at / DROP)), at + BEAT / 2)
    if at >= 2.0 and at < DROP - 0.5: put(drums, kick(0.25 + 0.4 * min(1, (at - 2) / 10)), at); kick_times.append(at)
for at in (2.15, 2.9, 4.2, 4.9, 6.15, 7.25, 8.4, 9.1, 10.1, 10.75): put(fx, bell(mf(90 if at < 6 else 86), 0.8, 0.10, 7), at)
put(fx, kick(1.1), 9.4); put(fx, bell(mf(47), 1.8, 0.2, 3.0), 9.4)
for at in (2.0, 4.0, 6.0, 8.0, 10.0): put(fx, whoosh(0.5, 0.4), at - 0.25)
put(fx, riser(6.0, DROP, 0.5), 6.0)
for i, at in enumerate(np.arange(11.0, DROP, 0.125)): put(drums, snare(0.2 + 0.07 * i), at)

# ── the drop (12.0)
put(fx, kick(1.7), DROP); kick_times.append(DROP); put(fx, whoosh(1.2, 0.9, False), DROP - 0.5); put(fx, bell(mf(38), 3.0, 0.7, 1.4), DROP)
put(fx, hp(rng.standard_normal(int(1.4 * SR)), 5) * np.exp(-tt(1.4) * 3) * 0.7, DROP)

# ── groove 12-25
for bar_start in np.arange(DROP, 25.0, 2.0):
    bi = int((bar_start - DROP) // 2); name, root, tones = CHORDS[bi % 4]
    quiet = 14.0 <= bar_start < 20.0          # leave room for the demo
    for b in range(4):
        at = bar_start + b * BEAT
        if at >= 25.0: break
        put(drums, kick(0.95), at); kick_times.append(at)
        if b in (1, 3): put(drums, clap(0.5), at); put(drums, snare(0.18), at)
        put(drums, hat(0.30, open_=True), at + BEAT / 2)
        for q in range(4): put(drums, shaker(0.10 if q % 2 else 0.16), at + q * BEAT / 4)
    # syncopated bass: root on 1, off-beat pickups on the "and"s, octave jump
    for beat, mult, ln in ((0, 1, .75), (1.5, 1, .5), (2.5, 2, .5), (3.25, 1, .5)):
        at = bar_start + beat * BEAT
        if at < 25.0: put(music, sub(mf(root) * mult, 0.3, 0.55), at)
    # pad: detuned saws held for the bar
    for m in tones: put(music, supersaw(mf(m), 2.0, 0.11, 46), bar_start)
    # piano-style stabs on the off-beats
    for beat in (0.5, 1.5, 2.5, 3.5):
        at = bar_start + beat * BEAT
        if at >= 25.0: break
        for m in tones: put(music, piano(mf(m + 12), 0.4, 0.07), at)
    # the hook
    for beat, m, ln in HOOK[bi % 4]:
        at = bar_start + beat * BEAT
        if at < 25.0: put(music, lead(mf(m), ln * BEAT + 0.12, 0.17 if quiet else 0.26), at)
# the demo (14-20): small notes where speech and the board happen
for at in (14.9, 17.25): put(fx, bell(mf(81), 0.8, 0.2, 6), at)
for at in (16.25, 18.35): put(fx, bell(mf(76), 0.8, 0.18, 6), at)
for at in (14.45, 17.0, 19.0): put(fx, bell(mf(86), 0.9, 0.22, 5), at)
put(fx, bell(mf(90), 2.2, 0.5, 2.2), 19.25); put(fx, bell(mf(93), 2.0, 0.28, 2.6), 19.38)
for at in np.linspace(19.25, 19.5, 8): put(fx, hat(0.2), at)
# features (20-25): a chord stab and a whoosh on every cut, a snare roll into the logo
for at in (20.0, 21.25, 22.5, 23.75): put(fx, whoosh(0.5, 0.5), at - 0.25); [put(fx, piano(mf(m + 12), 0.55, 0.16), at) for m in (62, 66, 69, 74)]
for i, at in enumerate(np.arange(24.0, 25.0, 0.125)): put(drums, snare(0.25 + 0.05 * i), at)
# ── the logo (25-30): D major, a bell, the hook's last phrase, a held chord
put(fx, whoosh(0.5, 0.6), 24.75)
put(fx, kick(1.5), 25.0); kick_times.append(25.0); put(fx, bell(mf(86), 3.8, 0.5, 1.3), 25.0); put(fx, bell(mf(93), 3.6, 0.28, 1.5), 25.05)
put(fx, hp(rng.standard_normal(int(1.6 * SR)), 5) * np.exp(-tt(1.6) * 3) * 0.5, 25.0)
for at in np.arange(25.5, 28.0, BEAT): put(drums, kick(0.6), at); kick_times.append(at)
for b in range(6): put(drums, hat(0.2, True), 25.0 + b * BEAT + BEAT / 2)
for beat, m, ln in [(0, 78, 1), (1, 81, .5), (1.5, 78, .5), (2, 74, 1), (3, 78, 2.5)]: put(music, lead(mf(m), ln * BEAT + 0.15, 0.24), 25.0 + beat * BEAT)
for m in (50, 62, 66, 69, 74): put(music, supersaw(mf(m), 5.0, 0.11, 50), 25.0)
for beat in (0.5, 1.5, 2.5, 3.5, 4.5): [put(music, piano(mf(m + 12), 0.4, 0.06), 25.0 + beat * BEAT) for m in (62, 66, 69)]
# long soft pad so the last seconds are not silent
for f in (mf(50), mf(62), mf(66), mf(69)):
    e = np.zeros(N); i0 = int(25.0 * SR); x = np.ones(N - i0); x[: int(0.4 * SR)] = np.linspace(0, 1, int(0.4 * SR)); x[-int(1.2 * SR):] = np.linspace(1, 0, int(1.2 * SR)); e[i0:] = x
    music += np.sin(2 * np.pi * f * t) * e * 0.03
# ── mix
duck = np.ones(N)
for kt in kick_times:
    i0 = int(kt * SR); n = int(0.2 * SR); k = 1 - 0.7 * np.exp(-tt(0.2) * 15)
    duck[i0:i0 + n] = np.minimum(duck[i0:i0 + n], k[: max(0, min(n, N - i0))])
mix = music * duck * 0.9 + drums * 0.85 + fx * 0.8
mix += lp(rng.standard_normal(N), 300) * 0.9 * (0.02 + 0.012 * np.sin(2 * np.pi * 0.13 * t))
d = int(0.011 * SR); L = mix.copy(); R = np.concatenate([np.zeros(d), mix[:-d]])
width = hp(fx + drums * 0.3, 60); L += width * 0.12; R -= width * 0.12
st = np.stack([L, R], 1)
st *= (np.minimum(1, t / 0.08) * np.minimum(1, (DUR - t) / 1.4))[:, None]
st = np.tanh(st * 1.25); st *= 0.66 / np.max(np.abs(st))
with wave.open(sys.argv[1] if len(sys.argv) > 1 else "otto-track2.wav", "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((st * 32767).astype(np.int16).tobytes())
print("ok")

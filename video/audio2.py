# Music for launch2.html: 120 BPM. Tense news-bed 0-12 (pulse, data blips, riser) -> drop at 12.0 -> groove -> feature stabs -> resolve. Pure numpy.
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

CH = {"Am": (110.0, [220, 261.63, 329.63, 440]), "F": (87.31, [174.61, 220, 261.63, 349.23]),
      "C": (130.81, [261.63, 329.63, 392.0, 523.25]), "G": (98.0, [196, 246.94, 293.66, 392.0]),}
prog = ["Am", "F", "C", "G"]
DROP = 12.0
def chord_at(time):
    if time >= 25: return "C"
    return prog[int((time - DROP) // 2) % 4]
drums = np.zeros(N); music = np.zeros(N); fx = np.zeros(N); kick_times = []
# ── news bed (0-12): drone, ticking hats, a pulse that grows, blips on every data reveal, a long riser, a snare roll into the drop
music += np.sin(2 * np.pi * 55 * t) * (t < DROP) * np.minimum(1, t / 2.0) * (0.10 + 0.10 * np.clip(t / DROP, 0, 1))
music += np.sin(2 * np.pi * 110.4 * t) * (t < DROP) * np.minimum(1, t / 3.0) * 0.06
music += np.sin(2 * np.pi * 82.4 * t) * (t > 6) * (t < DROP) * np.minimum(1, (t - 6) / 3.0) * 0.07
for i in range(int(DROP / BEAT)):
    at = i * BEAT
    put(drums, hat(0.10 + 0.10 * min(1, at / DROP)), at + BEAT / 2)
    if at >= 1.0 and at < DROP - 0.5: put(drums, kick(0.28 + 0.4 * min(1, at / DROP)), at); kick_times.append(at)
for at in (2.15, 2.9, 4.2, 4.9, 6.15, 7.25, 8.4, 9.1, 10.1, 10.75):
    put(fx, bell(1318.5 if at < 6 else 987.77, 0.7, 0.10, 8), at); put(fx, hat(0.18), at)
put(fx, kick(1.0), 9.4)                                   # the -17% lands
put(fx, bell(220, 1.6, 0.18, 3.0), 9.4)
for at in (2.0, 4.0, 6.0, 8.0, 10.0): put(fx, whoosh(0.5, 0.45), at - 0.25)
put(fx, riser(6.0, DROP, 0.5), 6.0)
for i, at in enumerate(np.arange(11.0, DROP, 0.125)): put(drums, snare(0.2 + 0.07 * i), at)
# ── the drop at 12.0
put(fx, kick(1.7), DROP); kick_times.append(DROP); put(fx, whoosh(1.2, 0.9, False), DROP - 0.5); put(fx, bell(110, 3.0, 0.7, 1.4), DROP)
put(fx, hp(rng.standard_normal(int(1.4 * SR)), 5) * np.exp(-tt(1.4) * 3) * 0.7, DROP)
# ── groove 12-25
for bar_start in np.arange(DROP, 25.0, 2.0):
    ch = chord_at(bar_start); root, tones = CH[ch]
    for b in range(4):
        at = bar_start + b * BEAT
        if at >= 25.0: break
        put(drums, kick(0.95), at); kick_times.append(at)
        if b in (1, 3): put(drums, clap(0.55), at)
        put(drums, hat(0.32, open_=True), at + BEAT / 2); put(drums, hat(0.13), at + BEAT / 4); put(drums, hat(0.13), at + 3 * BEAT / 4)
        put(music, bass(root, 0.34, 0.5), at + BEAT / 2)
        if b in (0, 2): put(music, bass(root, 0.4, 0.55), at)
    order = [0, 1, 2, 3, 2, 1, 2, 3]
    for s_ in range(16):
        at = bar_start + s_ * BEAT / 4
        if at >= 25.0: break
        put(music, pluck(tones[order[s_ % 8]] * (2 if (s_ // 8) else 1), 0.4, 0.22 if s_ % 4 else 0.3), at)
    put(music, stab(tones, 0.9, 0.18), bar_start)
# the demo (14-20): small notes where speech and the board happen
for at in (14.9, 17.25): put(fx, bell(784, 0.8, 0.22, 6), at)
for at in (16.25, 18.35): put(fx, bell(587.33, 0.8, 0.2, 6), at)
for at in (14.45, 17.0, 19.0): put(fx, bell(880, 0.9, 0.25, 5), at)
put(fx, bell(1318.5, 2.2, 0.55, 2.2), 19.25); put(fx, bell(1760, 2.0, 0.3, 2.6), 19.38)   # success chime
for at in np.linspace(19.25, 19.5, 8): put(fx, hat(0.2), at)
# features (20-25): a stab and a whoosh on every cut
for at in (20.0, 21.25, 22.5, 23.75): put(fx, whoosh(0.5, 0.5), at - 0.25); put(fx, stab([523.25, 659.25, 783.99], 0.5, 0.35), at)
for i, at in enumerate(np.arange(24.0, 25.0, 0.125)): put(drums, snare(0.25 + 0.05 * i), at)
# ── the logo (25-30)
put(fx, whoosh(0.5, 0.6), 24.75)
put(fx, kick(1.5), 25.0); kick_times.append(25.0); put(fx, bell(1046.5, 3.8, 0.5, 1.3), 25.0); put(fx, bell(1568.0, 3.6, 0.28, 1.5), 25.05)
put(fx, hp(rng.standard_normal(int(1.6 * SR)), 5) * np.exp(-tt(1.6) * 3) * 0.5, 25.0)
for at in np.arange(25.5, 28.0, BEAT): put(drums, kick(0.6), at); kick_times.append(at)
for b in range(6): put(drums, hat(0.2, True), 25.0 + b * BEAT + BEAT / 2)
for s_ in range(20): put(music, pluck([523.25, 659.25, 783.99, 1046.5][[0, 1, 2, 3, 2, 1, 2, 1][s_ % 8]], 0.4, 0.16), 25.0 + s_ * BEAT / 4)
put(music, stab(CH["C"][1] + [130.81], 3.5, 0.3), 25.0); put(music, stab(CH["C"][1] + [130.81], 3.0, 0.22), 27.0)
put(fx, bell(2093.0, 2.0, 0.25, 3), 27.0)
# a soft sustained C chord under the logo so the last seconds are not silent
for f in (130.81, 196.0, 261.63, 329.63, 392.0):
    e = np.zeros(N); i0, i1 = int(25.0 * SR), N; x = np.ones(i1 - i0); x[: int(0.4 * SR)] = np.linspace(0, 1, int(0.4 * SR)); x[-int(1.2 * SR):] = np.linspace(1, 0, int(1.2 * SR)); e[i0:i1] = x
    music += np.sin(2 * np.pi * f * t) * e * 0.035
# ── mix: sidechain the music to the kick, then master
duck = np.ones(N)
for kt in kick_times:
    i0 = int(kt * SR); n = int(0.22 * SR); k = 1 - 0.75 * np.exp(-tt(0.22) * 16)
    duck[i0:i0 + n] = np.minimum(duck[i0:i0 + n], k[: max(0, min(n, N - i0))])
mix = music * duck * 0.9 + drums * 0.85 + fx * 0.8
mix += lp(rng.standard_normal(N), 300) * 0.9 * (0.02 + 0.012 * np.sin(2 * np.pi * 0.13 * t))
d = int(0.011 * SR); L = mix.copy(); R = np.concatenate([np.zeros(d), mix[:-d]])
width = hp(fx + drums * 0.3, 60); L += width * 0.12; R -= width * 0.12
st = np.stack([L, R], 1)
st *= (np.minimum(1, t / 0.08) * np.minimum(1, (DUR - t) / 1.4))[:, None]
st = np.tanh(st * 1.25); st *= 0.66 / np.max(np.abs(st))
with wave.open(sys.argv[1] if len(sys.argv) > 1 else "otto-launch2.wav", "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((st * 32767).astype(np.int16).tobytes())
print("ok")

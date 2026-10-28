# Synthesises the film's music: 120 BPM, one beat = 0.5 s, so every cut in launch.html lands on a beat.
# Intro tension -> drop at 4.0 -> four-on-the-floor house groove -> stop-time hits -> resolve. Pure numpy, nothing sampled.
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
def chord_at(time):
    if time >= 28: return "C"
    if time < 4: return "Am"
    return prog[int((time - 4) // 2) % 4]

drums = np.zeros(N); music = np.zeros(N); fx = np.zeros(N)
kick_times = []
# ── intro (0–4): a ticking pulse that tightens, a low drone, then a riser into the drop
for i in range(8): put(drums, hat(0.25), i * BEAT)
for i in range(2, 8): put(drums, kick(0.35 + 0.08 * i), i * BEAT); kick_times.append(i * BEAT)
for i, at in enumerate(np.arange(3.0, 4.0, 0.125)): put(drums, snare(0.25 + 0.05 * i), at)  # snare roll, 16ths
put(fx, riser(1.5, 4.0, 0.5), 1.5)
music += np.sin(2 * np.pi * 55 * t) * (t < 4) * np.minimum(1, t / 1.5) * 0.18
music += np.sin(2 * np.pi * 110.4 * t) * (t < 4) * np.minimum(1, t / 2.0) * 0.07
# ── the drop at 4.0
put(fx, kick(1.6), 4.0); put(fx, whoosh(1.2, 0.9, False), 3.6); put(fx, bell(55 * 2, 3.0, 0.7, 1.4), 4.0)
put(fx, hp(rng.standard_normal(int(1.4 * SR)), 5) * np.exp(-tt(1.4) * 3) * 0.7, 4.0)  # crash
# ── groove 4–24: four on the floor, claps on 2 & 4, off-beat hats, bass on the off-beats, plucks on 16ths
for bar_start in np.arange(4.0, 24.0, 2.0):
    ch = chord_at(bar_start); root, tones = CH[ch]
    for b in range(4):
        at = bar_start + b * BEAT
        put(drums, kick(0.95), at); kick_times.append(at)
        if b in (1, 3): put(drums, clap(0.55), at)
        put(drums, hat(0.32, open_=True), at + BEAT / 2)
        put(drums, hat(0.13), at + BEAT / 4); put(drums, hat(0.13), at + 3 * BEAT / 4)
        put(music, bass(root, 0.34, 0.5), at + BEAT / 2)
        if b in (0, 2): put(music, bass(root, 0.4, 0.55), at)
    # arpeggio on 16ths
    order = [0, 1, 2, 3, 2, 1, 2, 3]
    for s in range(16):
        f = tones[order[s % 8]] * (2 if (s // 8) else 1)
        put(music, pluck(f, 0.4, 0.22 if s % 4 else 0.3), bar_start + s * BEAT / 4)
    put(music, stab(tones, 0.9, 0.18), bar_start)                       # a soft chord on the downbeat
# feature montage (12–18): a chord stab on every cut, plus whooshes at the swipes
for at in (12.0, 13.5, 15.0, 16.5, 18.0): put(fx, whoosh(0.6, 0.55), at - 0.3); put(fx, stab([523.25, 659.25, 783.99], 0.5, 0.35), at)
# 18–24 gets extra energy: a second hat layer and a snare fill at the end
for at in np.arange(18.0, 24.0, BEAT / 2): put(drums, hat(0.07), at + BEAT / 4)
for i, at in enumerate(np.arange(23.0, 24.0, 0.125)): put(drums, snare(0.3 + 0.04 * i), at)
put(fx, riser(22.0, 24.0, 0.35), 22.0)
# ── stop-time hits for THINK. OUT. LOUD. (24–26)
for i, at in enumerate((24.0, 24.5, 25.0)):
    put(drums, kick(1.2), at); kick_times.append(at); put(fx, stab([220 * 2 ** (i / 6), 277.18, 329.63], 0.7, 0.4), at)
put(fx, whoosh(0.5, 0.7), 25.4)
# ── the logo (26–30): resolve in C, light groove, a bell, then ring out
put(fx, kick(1.5), 26.0); kick_times.append(26.0); put(fx, bell(1046.5, 3.6, 0.5, 1.3), 26.0); put(fx, bell(1568.0, 3.4, 0.28, 1.5), 26.05)
put(fx, hp(rng.standard_normal(int(1.6 * SR)), 5) * np.exp(-tt(1.6) * 3) * 0.5, 26.0)
for at in np.arange(26.5, 28.5, BEAT): put(drums, kick(0.6), at); kick_times.append(at)
for b in range(4): put(drums, hat(0.2, True), 26.0 + b * BEAT + BEAT / 2)
for s in range(16): put(music, pluck([523.25, 659.25, 783.99, 1046.5][[0, 1, 2, 3, 2, 1, 2, 1][s % 8]], 0.4, 0.16), 26.0 + s * BEAT / 4)
put(music, stab(CH["C"][1] + [130.81], 3.5, 0.3), 26.0)
put(music, stab(CH["C"][1] + [130.81], 3.0, 0.22), 28.0)
put(fx, bell(2093.0, 2.0, 0.25, 3), 28.0)
# ── events inside the demo (6–12), matching the on-screen beats
for at in (6.9, 9.25): put(fx, bell(784, 0.8, 0.22, 6), at)
for at in (8.25, 10.35): put(fx, bell(587.33, 0.8, 0.2, 6), at)
put(fx, bell(880, 0.9, 0.25, 5), 9.0); put(fx, bell(880, 0.9, 0.25, 5), 11.0)
put(fx, bell(1318.5, 2.2, 0.55, 2.2), 11.25); put(fx, bell(1760, 2.0, 0.3, 2.6), 11.38)       # success chime
for i, at in enumerate(np.linspace(11.25, 11.5, 8)): put(fx, hat(0.2), at)
# ── mixing: sidechain the music to the kick, then master
duck = np.ones(N)
for kt in kick_times:
    i0 = int(kt * SR); n = int(0.22 * SR); k = 1 - 0.75 * np.exp(-tt(0.22) * 16)
    duck[i0:i0 + n] = np.minimum(duck[i0:i0 + n], k[: max(0, min(n, N - i0))])
mix = music * duck * 0.9 + drums * 0.85 + fx * 0.8
# a quiet filtered-noise bed that breathes with the sections
bed = lp(rng.standard_normal(N), 300) * 0.9 * (0.02 + 0.012 * np.sin(2 * np.pi * 0.13 * t))
mix += bed
# stereo width: haas + gentle opposite panning of the high percussion
d = int(0.011 * SR); L = mix.copy(); R = np.concatenate([np.zeros(d), mix[:-d]])
width = (hp(fx + drums * 0.3, 60))
L += width * 0.12; R -= width * 0.12
st = np.stack([L, R], 1)
st *= (np.minimum(1, t / 0.08) * np.minimum(1, (DUR - t) / 1.2))[:, None]
st = np.tanh(st * 1.25)
st *= 0.66 / np.max(np.abs(st))
with wave.open(sys.argv[1] if len(sys.argv) > 1 else "otto-launch.wav", "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((st * 32767).astype(np.int16).tobytes())
print("ok")

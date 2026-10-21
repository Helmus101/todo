// AudioWorklet for the live voice: hands the microphone's raw samples to the page. A real file (not a blob:) because the app's CSP only allows scripts from its own origin.
class Tap extends AudioWorkletProcessor { process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch && ch.length) this.port.postMessage(ch.slice(0)); return true; } }
registerProcessor("otto-tap", Tap);

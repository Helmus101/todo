# Otto companion (Arduino Mega 2560)

A USB device with three buttons and three lights that sits next to the laptop while the student works with Otto. It is optional: Otto works the same without it.

| Part | Pin | Does |
|---|---|---|
| Button HELP | D2 → GND | asks Otto for a hint (same as typing "I'm stuck") |
| Button NEXT | D3 → GND | "what should we do next?" |
| Button MIC | D4 → GND | reserved (does nothing yet: voice mode is only ever switched on screen) |
| Green LED + 220 Ω | D8 → GND | Otto is listening |
| Amber LED + 220 Ω | D9 → GND | Otto is thinking (pulses) |
| Blue LED + 220 Ω | D10 → GND | Otto is speaking |
| Buzzer (optional) | D11 → GND | short tone |
| 16×2 I2C LCD (optional) | SDA 20, SCL 21 | status text; uncomment `USE_LCD` (needs the `LiquidCrystal_I2C` library) |

Buttons use the internal pull-ups, so they need no resistors.

## Set up
1. Open `otto_companion/otto_companion.ino` in the Arduino IDE, choose **Arduino Mega or Mega 2560**, upload.
2. Serial Monitor at 115200 baud: pressing a button prints `{"btn":"help"}`. Typing `{"state":"thinking"}` and Enter pulses the amber light.
3. Open the Tutor in **Chrome or Edge** (Web Serial; not Safari or Firefox), start a session, click the USB icon in the top bar and choose the Mega. Close the Arduino Serial Monitor first — only one program can hold the port.

## Protocol (`shared/deviceProtocol.ts`)
One JSON line each way at 115200 baud. Device → app: `{"btn":"help|next|mic"}`, `{"hello":"otto-mega"}`. App → device: `{"state":"idle|listening|thinking|speaking|offline"}`, `{"lcd":"≤16 ASCII chars"}`, `{"beep":"ok|no"}`. The device never receives answers or what the student said.

## Notes
- The Mega resets when the browser opens the port; the app waits 2 s before sending.
- Pulling the cable just disconnects the pill; the tutor keeps working.
- The MIC button is reserved: voice mode is never switched by anything except the student's own click on screen.

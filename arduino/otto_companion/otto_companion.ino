// Otto companion — Arduino Mega 2560 over USB serial (115200 baud).
// Wiring (see ../README.md):
//   Buttons (other leg to GND, internal pull-ups):  HELP = D2, NEXT = D3, MIC = D4
//   LEDs (220 ohm resistor each, other leg to GND):  GREEN (listening) = D8, AMBER (thinking) = D9, BLUE (speaking) = D10
//   Optional: 16x2 I2C LCD on SDA 20 / SCL 21 (uncomment USE_LCD), piezo buzzer on D11.
// Protocol: one JSON object per line.   device -> app: {"btn":"help"|"next"|"mic"}, {"hello":"otto-mega"}
//                                       app -> device: {"state":"idle|listening|thinking|speaking|offline"}, {"lcd":"text"}, {"beep":"ok|no"}
// The device never sees answers or what the student said.

// #define USE_LCD
#ifdef USE_LCD
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
LiquidCrystal_I2C lcd(0x27, 16, 2);
#endif

const uint8_t BTN_PINS[3] = {2, 3, 4};
const char* BTN_NAMES[3] = {"help", "next", "mic"};
const uint8_t LED_LISTEN = 8, LED_THINK = 9, LED_SPEAK = 10, BUZZER = 11;
const unsigned long DEBOUNCE_MS = 30;

bool lastRead[3] = {HIGH, HIGH, HIGH};
bool stable[3] = {HIGH, HIGH, HIGH};
unsigned long changedAt[3] = {0, 0, 0};
char line[160];
uint8_t len = 0;
unsigned long lastPulse = 0;
bool thinkingOn = false, thinking = false;

void setLeds(bool listen, bool think, bool speak) {
  digitalWrite(LED_LISTEN, listen);
  digitalWrite(LED_THINK, think);
  digitalWrite(LED_SPEAK, speak);
}

void showText(const char* s) {
#ifdef USE_LCD
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(s);
#endif
}

// Finds "key":"value" in a flat JSON line; copies value (max n-1 chars). No library, no allocation.
bool field(const char* json, const char* key, char* out, uint8_t n) {
  char pat[16];
  snprintf(pat, sizeof(pat), "\"%s\":\"", key);
  const char* p = strstr(json, pat);
  if (!p) return false;
  p += strlen(pat);
  uint8_t i = 0;
  while (*p && *p != '"' && i < n - 1) out[i++] = *p++;
  out[i] = 0;
  return true;
}

void beep(bool ok) {
  tone(BUZZER, ok ? 1760 : 220, ok ? 80 : 200);
}

void handleLine(const char* json) {
  char v[24];
  if (field(json, "state", v, sizeof(v))) {
    thinking = !strcmp(v, "thinking");
    if (!strcmp(v, "listening")) setLeds(true, false, false);
    else if (thinking) setLeds(false, true, false);
    else if (!strcmp(v, "speaking")) setLeds(false, false, true);
    else setLeds(false, false, false); // idle / offline
  } else if (field(json, "lcd", v, 17)) {
    showText(v);
  } else if (field(json, "beep", v, sizeof(v))) {
    beep(!strcmp(v, "ok"));
  }
}

void setup() {
  Serial.begin(115200);
  for (uint8_t i = 0; i < 3; i++) pinMode(BTN_PINS[i], INPUT_PULLUP);
  pinMode(LED_LISTEN, OUTPUT); pinMode(LED_THINK, OUTPUT); pinMode(LED_SPEAK, OUTPUT); pinMode(BUZZER, OUTPUT);
#ifdef USE_LCD
  lcd.init(); lcd.backlight();
#endif
  setLeds(true, true, true); delay(300); setLeds(false, false, false); // power-on blink
  Serial.println("{\"hello\":\"otto-mega\"}");
}

void loop() {
  unsigned long now = millis();
  // Buttons: send once per press, after DEBOUNCE_MS of stable LOW.
  for (uint8_t i = 0; i < 3; i++) {
    bool r = digitalRead(BTN_PINS[i]);
    if (r != lastRead[i]) { lastRead[i] = r; changedAt[i] = now; }
    if (now - changedAt[i] > DEBOUNCE_MS && r != stable[i]) {
      stable[i] = r;
      if (r == LOW) { Serial.print("{\"btn\":\""); Serial.print(BTN_NAMES[i]); Serial.println("\"}"); }
    }
  }
  // Thinking: the amber LED pulses so "waiting" never looks frozen.
  if (thinking && now - lastPulse > 350) { lastPulse = now; thinkingOn = !thinkingOn; digitalWrite(LED_THINK, thinkingOn); }
  // Serial in: accumulate until newline; overlong lines are dropped.
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') { line[len] = 0; if (len) handleLine(line); len = 0; }
    else if (c != '\r') { if (len < sizeof(line) - 1) line[len++] = c; else len = 0; }
  }
}

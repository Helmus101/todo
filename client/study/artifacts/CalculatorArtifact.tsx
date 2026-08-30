import { useState } from "react";

export function CalculatorArtifact() {
  const [display, setDisplay] = useState("0");
  const [prev, setPrev] = useState<string | null>(null);
  const [op, setOp] = useState<string | null>(null);
  const [waitingForOperand, setWaitingForOperand] = useState(false);

  const inputDigit = (digit: string) => {
    if (waitingForOperand) {
      setDisplay(digit);
      setWaitingForOperand(false);
    } else {
      setDisplay(display === "0" ? digit : display + digit);
    }
  };

  const inputDot = () => {
    if (waitingForOperand) { setDisplay("0."); setWaitingForOperand(false); return; }
    if (!display.includes(".")) setDisplay(display + ".");
  };

  const calculate = (a: number, b: number, operator: string) => {
    switch (operator) {
      case "+": return a + b;
      case "−": return a - b;
      case "×": return a * b;
      case "÷": return b !== 0 ? a / b : NaN;
    }
    return b;
  };

  const handleOp = (operator: string) => {
    const val = parseFloat(display);
    if (prev !== null && op && !waitingForOperand) {
      const result = calculate(parseFloat(prev), val, op);
      setDisplay(String(parseFloat(result.toFixed(10))));
      setPrev(String(parseFloat(result.toFixed(10))));
    } else {
      setPrev(display);
    }
    setOp(operator);
    setWaitingForOperand(true);
  };

  const handleEquals = () => {
    if (prev === null || op === null) return;
    const result = calculate(parseFloat(prev), parseFloat(display), op);
    setDisplay(String(parseFloat(result.toFixed(10))));
    setPrev(null);
    setOp(null);
    setWaitingForOperand(true);
  };

  const clear = () => { setDisplay("0"); setPrev(null); setOp(null); setWaitingForOperand(false); };
  const toggleSign = () => setDisplay(String(-parseFloat(display)));
  const percent = () => setDisplay(String(parseFloat(display) / 100));

  const btn = (label: string, action: () => void, variant = "") => (
    <button className={`sm-calc-btn ${variant}`} onClick={action}>{label}</button>
  );

  return (
    <div className="sm-calculator">
      <div className="sm-calc-display">
        <span className="sm-calc-op">{op || ""}</span>
        <span className="sm-calc-val">{display}</span>
      </div>
      <div className="sm-calc-grid">
        {btn("AC", clear, "sm-calc-fn")}
        {btn("+/-", toggleSign, "sm-calc-fn")}
        {btn("%", percent, "sm-calc-fn")}
        {btn("÷", () => handleOp("÷"), "sm-calc-op-btn")}
        {btn("7", () => inputDigit("7"))}
        {btn("8", () => inputDigit("8"))}
        {btn("9", () => inputDigit("9"))}
        {btn("×", () => handleOp("×"), "sm-calc-op-btn")}
        {btn("4", () => inputDigit("4"))}
        {btn("5", () => inputDigit("5"))}
        {btn("6", () => inputDigit("6"))}
        {btn("−", () => handleOp("−"), "sm-calc-op-btn")}
        {btn("1", () => inputDigit("1"))}
        {btn("2", () => inputDigit("2"))}
        {btn("3", () => inputDigit("3"))}
        {btn("+", () => handleOp("+"), "sm-calc-op-btn")}
        <button className="sm-calc-btn sm-calc-zero" onClick={() => inputDigit("0")}>0</button>
        {btn(".", inputDot)}
        {btn("=", handleEquals, "sm-calc-eq")}
      </div>
    </div>
  );
}

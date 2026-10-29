// A small bank of practice questions for the IB subjects where an answer can be checked by arithmetic. Every question is
// original to Otto (not a real past-paper question), written in the IB's style (a short context, parts with marks, a command
// term for each), and carries a mark scheme in the IB's M / A / R codes. Each one also carries a `check` that recomputes
// its answers from the question's own numbers, and the test suite runs every check, so a wrong answer cannot ship.
// The tutor is told to pose these instead of inventing a question it cannot check, and never to show the scheme.

export type BankSubject = "math-aa" | "math-ai" | "physics" | "chemistry" | "economics" | "biology";

export interface BankQuestion {
  id: string;
  subject: BankSubject;
  /** "SL", "HL", or "both" (an SL or an HL student can be given it). */
  level: "SL" | "HL" | "both";
  topic: string;
  paper: string;
  marks: number;
  question: string;
  /** The mark scheme, one line per mark or group of marks. Private: for marking, never shown to the student. */
  scheme: string[];
  /** Recomputes the answers from the numbers in the question. Must return true. */
  check: () => boolean;
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const erf = (x: number) => { const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)); };
const Phi = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));

export const QUESTION_BANK: BankQuestion[] = [
  // ---------------------------------------------------------------- Mathematics: Analysis and Approaches
  {
    id: "aa-cubic-stationary", subject: "math-aa", level: "both", topic: "Calculus: stationary points", paper: "Paper 1 style (no calculator)", marks: 8,
    question: "The function f is defined by f(x) = x^3 - 6x^2 + 9x + 2.\n(a) Find f'(x). [2]\n(b) Find the coordinates of the two stationary points of the graph of f. [4]\n(c) Use the second derivative to determine the nature of each stationary point. [2]",
    scheme: ["(a) M1 attempt to differentiate a power; A1 f'(x) = 3x^2 - 12x + 9.", "(b) M1 set f'(x) = 0; M1 solve (3(x-1)(x-3) = 0); A1 x = 1 and x = 3; A1 (1, 6) and (3, 2) (both y-values needed).", "(c) M1 f''(x) = 6x - 12 and evaluate at the points; A1 f''(1) = -6 < 0 so maximum at (1, 6), f''(3) = 6 > 0 so minimum at (3, 2)."],
    check: () => { const f = (x: number) => x ** 3 - 6 * x ** 2 + 9 * x + 2; const d = (x: number) => 3 * x * x - 12 * x + 9; return d(1) === 0 && d(3) === 0 && f(1) === 6 && f(3) === 2 && 6 * 1 - 12 < 0 && 6 * 3 - 12 > 0; },
  },
  {
    id: "aa-geometric-sum", subject: "math-aa", level: "both", topic: "Sequences and series", paper: "Paper 2 style (calculator allowed)", marks: 6,
    question: "A geometric sequence has first term u1 = 5 and third term u3 = 20, and all of its terms are positive.\n(a) Find the common ratio. [2]\n(b) Find the sum of the first 8 terms. [2]\n(c) Find the smallest value of n for which the sum of the first n terms is greater than 10 000. [2]",
    scheme: ["(a) M1 u3 = u1 r^2 so 20 = 5 r^2; A1 r = 2 (reject -2 because the terms are positive).", "(b) M1 S8 = 5(2^8 - 1)/(2 - 1); A1 1275.", "(c) M1 5(2^n - 1) > 10 000 or a table or graph; A1 n = 11 (S10 = 5115, S11 = 10 235)."],
    check: () => { const S = (n: number) => 5 * (2 ** n - 1); return 5 * 4 === 20 && S(8) === 1275 && S(10) <= 10000 && S(11) > 10000 && S(10) === 5115 && S(11) === 10235; },
  },
  {
    id: "aa-binomial", subject: "math-aa", level: "both", topic: "Binomial expansion", paper: "Paper 1 style (no calculator)", marks: 3,
    question: "Find the coefficient of x^3 in the expansion of (2 + 3x)^5. [3]",
    scheme: ["M1 uses the binomial theorem with a term in x^3 (C(5,3) 2^2 (3x)^3).", "A1 correct term 10 x 4 x 27 x^3.", "A1 coefficient 1080."],
    check: () => { const C = (n: number, k: number) => { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; }; return C(5, 3) * 2 ** 2 * 3 ** 3 === 1080; },
  },
  {
    id: "aa-normal", subject: "math-aa", level: "both", topic: "Normal distribution", paper: "Paper 2 style (calculator allowed)", marks: 5,
    question: "The marks of a large group of students in a test are normally distributed with mean 70 and standard deviation 8.\n(a) Find the probability that a randomly chosen student scores more than 82. [2]\n(b) The top 10% of students receive a distinction. Find the lowest mark that earns a distinction. [3]",
    scheme: ["(a) M1 P(X > 82) with the correct distribution (or z = 1.5); A1 0.0668 (3 s.f.).", "(b) M1 P(X < k) = 0.9; M1 inverse normal (z = 1.2816); A1 k = 80.3 (3 s.f.)."],
    check: () => near(1 - Phi(1.5), 0.0668, 0.0005) && near(70 + 1.2816 * 8, 80.25, 0.01),
  },
  {
    id: "aa-proof-divisible", subject: "math-aa", level: "HL", topic: "Proof", paper: "Paper 1 style (no calculator)", marks: 6,
    question: "Prove that n^3 - n is divisible by 6 for every positive integer n. [6]",
    scheme: ["M1 factorise: n^3 - n = n(n - 1)(n + 1).", "A1 recognise three consecutive integers (n - 1, n, n + 1).", "R1 among any three consecutive integers at least one is even, so the product is divisible by 2.", "R1 among any three consecutive integers exactly one is a multiple of 3, so the product is divisible by 3.", "M1 2 and 3 share no common factor, so the product is divisible by 6.", "A1 a clear concluding statement. (Induction is an accepted alternative: base case, assumption, step, conclusion; every part is needed.)"],
    check: () => { for (let n = 1; n <= 2000; n++) if ((n ** 3 - n) % 6 !== 0) return false; return true; },
  },
  {
    id: "aa-sin3theta-hence", subject: "math-aa", level: "HL", topic: "Trigonometric identities", paper: "Paper 1 style (no calculator)", marks: 8,
    question: "(a) Show that sin 3theta = 3 sin theta - 4 sin^3 theta. [4]\n(b) Hence solve sin 3theta = 2 sin theta for 0 < theta < pi. [4]",
    scheme: ["(a) M1 sin 3theta = sin(2theta + theta) = sin 2theta cos theta + cos 2theta sin theta; M1 sin 2theta = 2 sin theta cos theta and cos 2theta = 1 - 2 sin^2 theta; A1 2 sin theta (1 - sin^2 theta) + (1 - 2 sin^2 theta) sin theta; AG 3 sin theta - 4 sin^3 theta (all steps shown, the result is given).", "(b) M1 uses the result: 3 sin theta - 4 sin^3 theta = 2 sin theta; M1 sin theta (1 - 4 sin^2 theta) = 0; R1 sin theta is not 0 in the interval, so sin theta = 1/2; A1 theta = pi/6 and 5pi/6 (both)."],
    check: () => { const f = (t: number) => Math.sin(3 * t) - 2 * Math.sin(t); if (!near(f(Math.PI / 6), 0, 1e-12) || !near(f((5 * Math.PI) / 6), 0, 1e-12)) return false; let roots = 0, prev = f(1e-6); for (let i = 1; i <= 100000; i++) { const t = (i * (Math.PI - 2e-6)) / 100000 + 1e-6; const v = f(t); if (prev === 0 || prev * v < 0) roots++; prev = v; } return roots === 2 && near(3 * Math.sin(0.7) - 4 * Math.sin(0.7) ** 3, Math.sin(2.1), 1e-12); },
  },
  {
    id: "aa-x2e-x", subject: "math-aa", level: "HL", topic: "Calculus: differentiation and optimisation", paper: "Paper 1 style (no calculator)", marks: 7,
    question: "Let f(x) = x^2 e^(-x), for x >= 0.\n(a) Find f'(x), giving your answer in the form x(a - x)e^(-x), where a is a constant. [3]\n(b) Find the x-coordinates of the stationary points of the graph of f. [2]\n(c) Find the exact maximum value of f, and justify that it is a maximum. [2]",
    scheme: ["(a) M1 product rule; A1 2x e^(-x) - x^2 e^(-x); A1 x(2 - x)e^(-x) (a = 2).", "(b) M1 set f'(x) = 0 (e^(-x) is never 0); A1 x = 0 and x = 2.", "(c) A1 f(2) = 4e^(-2); R1 justification: f' changes from positive to negative at x = 2 (or f'' < 0 there), and f(0) = 0 < 4e^(-2) so the point at x = 2 is the maximum."],
    check: () => { const f = (x: number) => x * x * Math.exp(-x); const d = (x: number) => (f(x + 1e-6) - f(x - 1e-6)) / 2e-6; return near(d(2), 0, 1e-6) && near(d(1.5), 1.5 * (2 - 1.5) * Math.exp(-1.5), 1e-6) && near(f(2), 4 * Math.exp(-2), 1e-12) && f(2) > f(1.9) && f(2) > f(2.1); },
  },
  {
    id: "aa-complex-power", subject: "math-aa", level: "HL", topic: "Complex numbers", paper: "Paper 1 style (no calculator)", marks: 6,
    question: "Let z = 1 + i sqrt(3).\n(a) Find the modulus and the argument of z. [3]\n(b) Hence find z^6, giving your answer in the form a + bi. [3]",
    scheme: ["(a) A1 |z| = 2; M1 arg z = arctan(sqrt(3)/1); A1 pi/3.", "(b) M1 de Moivre: z^6 = 2^6 (cos 6(pi/3) + i sin 6(pi/3)); A1 64 (cos 2pi + i sin 2pi); A1 64 + 0i, that is, 64."],
    check: () => { const m = Math.hypot(1, Math.sqrt(3)), a = Math.atan2(Math.sqrt(3), 1); return near(m, 2, 1e-12) && near(a, Math.PI / 3, 1e-12) && near(m ** 6 * Math.cos(6 * a), 64, 1e-9) && near(m ** 6 * Math.sin(6 * a), 0, 1e-9); },
  },
  // ---------------------------------------------------------------- Mathematics: Applications and Interpretation
  {
    id: "ai-compound", subject: "math-ai", level: "both", topic: "Financial mathematics", paper: "Paper 2 style (calculator allowed)", marks: 4,
    question: "Maya invests 12 000 euros at a nominal annual interest rate of 3.6%, compounded quarterly, for 5 years.\n(a) Find the value of the investment at the end of the 5 years, correct to the nearest euro. [3]\n(b) Maya's friend says that simple interest at 3.6% a year would give the same final value. Show that this is not true. [1]",
    scheme: ["(a) M1 uses the compound interest formula or the finance solver (N = 20, I% = 3.6, PV = -12 000, PMT = 0, P/Y = 1, C/Y = 4); A1 or R1 correct setup (20 compounding periods, 0.9% each); A1 14 355 euros.", "(b) R1 simple interest gives 12 000(1 + 0.036 x 5) = 14 160, which is less than 14 355, because with compounding the interest also earns interest."],
    check: () => Math.round(12000 * (1 + 0.036 / 4) ** 20) === 14355 && 12000 * (1 + 0.036 * 5) === 14160,
  },
  {
    id: "ai-regression", subject: "math-ai", level: "both", topic: "Correlation and regression", paper: "Paper 2 style (calculator allowed)", marks: 5,
    question: "The table shows the hours studied (x) and the test score (y) of five students.\nx: 1, 2, 3, 4, 5\ny: 2, 4, 5, 4, 6\n(a) Find the equation of the regression line of y on x. [2]\n(b) Find Pearson's product-moment correlation coefficient and describe the correlation. [2]\n(c) Use your equation to estimate the score of a student who studied for 3.5 hours, and comment on whether using it for 12 hours would be reliable. [1]",
    scheme: ["(a) M1 uses the regression function; A1 y = 0.8x + 1.8.", "(b) A1 r = 0.853 (3 s.f.); A1 strong positive linear correlation.", "(c) A1 y = 0.8(3.5) + 1.8 = 4.6; and R1 12 hours is far outside the data range (extrapolation) so it is unreliable (accept an answer that only does the estimate for A1 and loses the comment)."],
    check: () => { const x = [1, 2, 3, 4, 5], y = [2, 4, 5, 4, 6], mx = 3, my = 4.2; let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < 5; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; } const b = sxy / sxx; return near(b, 0.8, 1e-9) && near(my - b * mx, 1.8, 1e-9) && near(sxy / Math.sqrt(sxx * syy), 0.853, 0.0005) && near(0.8 * 3.5 + 1.8, 4.6, 1e-9); },
  },
  {
    id: "ai-normal", subject: "math-ai", level: "both", topic: "Normal distribution", paper: "Paper 2 style (calculator allowed)", marks: 5,
    question: "The marks of a large group of students in a test are normally distributed with mean 70 and standard deviation 8.\n(a) Find the probability that a randomly chosen student scores more than 82. [2]\n(b) The top 10% of students receive a distinction. Find the lowest mark that earns a distinction. [3]",
    scheme: ["(a) M1 normal cdf with the correct mean and standard deviation (state the lower bound 82); A1 0.0668.", "(b) M1 P(X < k) = 0.9; M1 inverse normal with mean 70 and sd 8; A1 80.3 (3 s.f.). Ask them to state what they entered into the calculator: a bare answer with no setup loses the method marks on a technology paper if it is wrong."],
    check: () => near(1 - Phi(1.5), 0.0668, 0.0005) && near(70 + 1.2816 * 8, 80.25, 0.01),
  },
  // ---------------------------------------------------------------- Physics
  {
    id: "phys-projectile", subject: "physics", level: "both", topic: "A.1 Kinematics: projectile motion", paper: "Paper 2 style (short answer)", marks: 5,
    question: "A ball is kicked from level ground with a speed of 20 m s^-1 at 30 degrees above the horizontal. Ignore air resistance and take g = 9.81 m s^-2.\n(a) Calculate the time the ball is in the air. [2]\n(b) Calculate the horizontal distance the ball travels before it lands. [2]\n(c) State the vertical component of the ball's velocity at its highest point. [1]",
    scheme: ["(a) C1 vertical component 20 sin 30 = 10 m s^-1 and t = 2 x 10 / 9.81; A1 2.04 s.", "(b) C1 horizontal component 20 cos 30 = 17.3 m s^-1 (constant); A1 17.3 x 2.04 = 35.3 m.", "(c) A1 zero."],
    check: () => { const t = (2 * 20 * Math.sin(Math.PI / 6)) / 9.81, r = 20 * Math.cos(Math.PI / 6) * t; return near(t, 2.04, 0.005) && near(r, 35.3, 0.05) && near((400 * Math.sin(Math.PI / 3)) / 9.81, r, 1e-9); },
  },
  {
    id: "phys-circuit", subject: "physics", level: "both", topic: "B.5 Current and circuits", paper: "Paper 2 style (short answer)", marks: 5,
    question: "A cell of emf 12 V and internal resistance 0.50 ohm is connected to a 4.0 ohm resistor and a 6.0 ohm resistor in parallel.\n(a) Calculate the total resistance of the external circuit. [1]\n(b) Calculate the current supplied by the cell. [2]\n(c) Calculate the terminal potential difference of the cell. [2]",
    scheme: ["(a) A1 1/R = 1/4 + 1/6, so R = 2.4 ohm.", "(b) C1 total resistance 2.4 + 0.50 = 2.9 ohm; A1 I = 12 / 2.9 = 4.1 A.", "(c) C1 V = emf - Ir (or V = I R with R = 2.4); A1 12 - 4.14 x 0.50 = 9.9 V."],
    check: () => { const R = 1 / (1 / 4 + 1 / 6), I = 12 / (R + 0.5); return near(R, 2.4, 1e-9) && near(I, 4.14, 0.01) && near(12 - I * 0.5, 9.93, 0.01) && near(I * R, 12 - I * 0.5, 1e-9); },
  },
  {
    id: "phys-bounce", subject: "physics", level: "both", topic: "A.3 Work, energy and power", paper: "Paper 2 style (short answer)", marks: 5,
    question: "A ball of mass 0.40 kg is dropped from a height of 1.8 m onto a hard floor and rebounds to a height of 1.2 m. Take g = 9.81 m s^-2 and ignore air resistance.\n(a) Calculate the speed of the ball just before it hits the floor. [2]\n(b) Calculate the speed of the ball just after it leaves the floor. [1]\n(c) Calculate the mechanical energy lost in the collision, and state where it goes. [2]",
    scheme: ["(a) C1 mgh = 1/2 m v^2 (or v^2 = 2gh); A1 5.9 m s^-1.", "(b) A1 v = sqrt(2 x 9.81 x 1.2) = 4.9 m s^-1.", "(c) C1 energy lost = mg(1.8 - 1.2) = 0.40 x 9.81 x 0.6; A1 2.4 J, transferred to thermal energy (and sound) in the ball and floor."],
    check: () => near(Math.sqrt(2 * 9.81 * 1.8), 5.94, 0.005) && near(Math.sqrt(2 * 9.81 * 1.2), 4.85, 0.005) && near(0.4 * 9.81 * 0.6, 2.354, 0.001) && near(0.5 * 0.4 * (Math.sqrt(2 * 9.81 * 1.8) ** 2 - Math.sqrt(2 * 9.81 * 1.2) ** 2), 0.4 * 9.81 * 0.6, 1e-9),
  },
  {
    id: "phys-decay", subject: "physics", level: "both", topic: "E.3 Radioactive decay", paper: "Paper 2 style (short answer)", marks: 4,
    question: "A radioactive sample has a half-life of 5.0 hours. Its initial activity is 800 Bq.\n(a) Calculate the activity after 12 hours. [2]\n(b) Determine the time at which the activity first falls to 50 Bq. [2]",
    scheme: ["(a) C1 A = A0 (1/2)^(t / T), with 12 / 5.0 = 2.4 half-lives; A1 150 Bq (152 Bq to 3 s.f.).", "(b) C1 800 -> 400 -> 200 -> 100 -> 50, which is 4 half-lives; A1 20 hours."],
    check: () => near(800 * 0.5 ** (12 / 5), 151.6, 0.1) && 800 * 0.5 ** 4 === 50,
  },
  {
    id: "phys-shm", subject: "physics", level: "HL", topic: "C.1 Simple harmonic motion", paper: "Paper 2 style (short answer)", marks: 5,
    question: "A mass of 0.25 kg hangs on a spring of spring constant 40 N m^-1 and oscillates vertically with amplitude 0.050 m.\n(a) Calculate the angular frequency of the oscillation. [2]\n(b) Calculate the period. [1]\n(c) Calculate the maximum speed of the mass. [2]",
    scheme: ["(a) C1 omega = sqrt(k / m); A1 12.6 rad s^-1.", "(b) A1 T = 2 pi / omega = 0.50 s.", "(c) C1 v_max = omega x A; A1 0.63 m s^-1."],
    check: () => { const w = Math.sqrt(40 / 0.25); return near(w, 12.65, 0.01) && near((2 * Math.PI) / w, 0.497, 0.001) && near(w * 0.05, 0.632, 0.001); },
  },
  // ---------------------------------------------------------------- Chemistry
  {
    id: "chem-moles-gas", subject: "chemistry", level: "both", topic: "S1.4 The mole", paper: "Paper 2 style (short answer)", marks: 4,
    question: "5.00 g of calcium carbonate, CaCO3 (M = 100.09 g mol^-1), reacts completely with excess hydrochloric acid: CaCO3 + 2HCl -> CaCl2 + H2O + CO2.\n(a) Calculate the amount, in mol, of calcium carbonate. [1]\n(b) State the amount of carbon dioxide produced. [1]\n(c) Calculate the volume of carbon dioxide at STP (molar volume 22.7 dm^3 mol^-1). [2]",
    scheme: ["(a) A1 5.00 / 100.09 = 0.0500 mol.", "(b) A1 0.0500 mol (1 : 1 ratio).", "(c) M1 V = n x 22.7; A1 1.13 dm^3."],
    check: () => near(5 / 100.09, 0.04996, 0.00001) && near((5 / 100.09) * 22.7, 1.134, 0.001),
  },
  {
    id: "chem-calorimetry", subject: "chemistry", level: "both", topic: "R1.1 Measuring enthalpy changes", paper: "Paper 2 style (short answer)", marks: 5,
    question: "The combustion of 0.50 g of ethanol (M = 46.07 g mol^-1) heats 100 g of water by 12.0 K. The specific heat capacity of water is 4.18 J g^-1 K^-1. Assume all the heat goes into the water.\n(a) Calculate the heat absorbed by the water, in kJ. [2]\n(b) Calculate the amount of ethanol burnt. [1]\n(c) Calculate the enthalpy change of combustion of ethanol, in kJ mol^-1, including its sign. [2]",
    scheme: ["(a) C1 q = m c deltaT = 100 x 4.18 x 12.0; A1 5016 J = 5.02 kJ.", "(b) A1 0.50 / 46.07 = 0.0109 mol.", "(c) C1 q / n = 5.016 / 0.010853; A1 -462 kJ mol^-1 (negative because the reaction is exothermic). Ask them why the value is smaller in size than the data-booklet value (heat lost to the surroundings, incomplete combustion)."],
    check: () => near(100 * 4.18 * 12 / 1000, 5.016, 1e-9) && near(0.5 / 46.07, 0.010853, 0.000001) && near(-(5.016 / (0.5 / 46.07)), -462.2, 0.1),
  },
  {
    id: "chem-ph", subject: "chemistry", level: "both", topic: "R3.1 Acid and base strength: pH", paper: "Paper 2 style (short answer)", marks: 4,
    question: "At 298 K, Kw = 1.00 x 10^-14.\n(a) Calculate the pH of 0.0100 mol dm^-3 hydrochloric acid. [1]\n(b) Calculate the pH of 0.0200 mol dm^-3 barium hydroxide, Ba(OH)2. [3]",
    scheme: ["(a) A1 pH = -log(0.0100) = 2.00.", "(b) A1 [OH-] = 2 x 0.0200 = 0.0400 mol dm^-3 (Ba(OH)2 gives two OH- per formula unit); M1 pOH = -log(0.0400) = 1.40 (or [H+] = Kw / [OH-]); A1 pH = 14.00 - 1.40 = 12.6."],
    check: () => near(-Math.log10(0.01), 2, 1e-9) && near(14 + Math.log10(0.04), 12.602, 0.001) && near(-Math.log10(1e-14 / 0.04), 12.602, 0.001),
  },
  {
    id: "chem-kc", subject: "chemistry", level: "both", topic: "R2.3 The equilibrium law", paper: "Paper 2 style (short answer)", marks: 4,
    question: "0.200 mol of N2O4 is placed in a 2.00 dm^3 sealed container at constant temperature. The equilibrium N2O4(g) <=> 2NO2(g) is established, and 0.120 mol of N2O4 remains.\n(a) Write the expression for Kc. [1]\n(b) Calculate the equilibrium concentrations of N2O4 and NO2. [2]\n(c) Calculate the value of Kc, with its units. [1]",
    scheme: ["(a) A1 Kc = [NO2]^2 / [N2O4].", "(b) C1 N2O4 consumed 0.080 mol so NO2 formed is 2 x 0.080 = 0.160 mol; A1 [N2O4] = 0.060 mol dm^-3 and [NO2] = 0.080 mol dm^-3.", "(c) A1 Kc = 0.080^2 / 0.060 = 0.107 mol dm^-3."],
    check: () => { const n2o4 = 0.12 / 2, no2 = (2 * (0.2 - 0.12)) / 2; return near(n2o4, 0.06, 1e-12) && near(no2, 0.08, 1e-12) && near(no2 ** 2 / n2o4, 0.1067, 0.0001); },
  },
  // ---------------------------------------------------------------- Economics
  {
    id: "econ-ped", subject: "economics", level: "both", topic: "Elasticity of demand", paper: "Paper 2 style (calculation)", marks: 4,
    question: "A firm raises the price of its product from 20 to 22 dollars. The quantity demanded falls from 500 to 450 units per week.\n(a) Calculate the price elasticity of demand (PED), showing your working. [2]\n(b) Calculate the change in total revenue and explain it using your answer to (a). [2]",
    scheme: ["(a) C1 %change in Qd = -50/500 = -10% and %change in P = 2/20 = +10%; A1 PED = -1.0 (unit elastic; accept 1.0 if the sign is explained).", "(b) A1 revenue falls from 10 000 to 9 900, a fall of 100 dollars; R1 PED is about unit elastic, so the change in revenue is small. (The more accurate midpoint elasticity is about -1.1, slightly elastic, which is why revenue falls a little.)"],
    check: () => near(((450 - 500) / 500) / ((22 - 20) / 20), -1, 1e-12) && 20 * 500 === 10000 && 22 * 450 === 9900 && near((-50 / 475) / (2 / 21), -1.105, 0.001),
  },
  {
    id: "econ-multiplier", subject: "economics", level: "both", topic: "The multiplier", paper: "Paper 2 style (calculation)", marks: 3,
    question: "An economy has a marginal propensity to save of 0.10, a marginal propensity to tax of 0.10 and a marginal propensity to import of 0.05. The government increases spending by 50 million dollars.\n(a) Calculate the value of the multiplier. [1]\n(b) Calculate the total increase in real GDP, and state one assumption you made. [2]",
    scheme: ["(a) A1 multiplier = 1 / (MPS + MPT + MPM) = 1 / 0.25 = 4.", "(b) A1 50 x 4 = 200 million dollars; R1 any valid assumption (the MPS, MPT and MPM stay constant; there is spare capacity so prices do not rise; no crowding out; the whole effect works through)."],
    check: () => near(1 / (0.1 + 0.1 + 0.05), 4, 1e-12) && near(50 * (1 / 0.25), 200, 1e-12),
  },
  // ---------------------------------------------------------------- Biology
  {
    id: "bio-magnification", subject: "biology", level: "both", topic: "B2.3 Organelles: magnification", paper: "Paper 2 style (short answer)", marks: 3,
    question: "In a micrograph, a chloroplast measures 45 mm in length. Its actual length is 0.15 mm.\n(a) Calculate the magnification of the micrograph. [2]\n(b) State the formula you used and explain why the answer has no unit. [1]",
    scheme: ["(a) C1 magnification = image size / actual size; A1 45 / 0.15 = x300.", "(b) R1 magnification = image / actual; it has no unit because it is a ratio of two lengths in the same unit (state the same unit for both before dividing: convert if one is in micrometres)."],
    check: () => near(45 / 0.15, 300, 1e-9),
  },
  {
    id: "bio-simpson", subject: "biology", level: "both", topic: "Biodiversity: Simpson's index", paper: "Paper 2 style (short answer)", marks: 3,
    question: "A student counts 20 individuals of three species in a quadrat: species A (10 individuals), species B (5) and species C (5). Use the formula D = 1 - sum of (n / N)^2.\n(a) Calculate the Simpson diversity index. [2]\n(b) Explain what a value close to 1 shows about a community. [1]",
    scheme: ["(a) C1 (10/20)^2 + (5/20)^2 + (5/20)^2 = 0.25 + 0.0625 + 0.0625 = 0.375; A1 D = 1 - 0.375 = 0.625.", "(b) R1 high diversity: many species with relatively even numbers, so a randomly chosen pair of individuals is likely to be of different species."],
    check: () => near(1 - ((10 / 20) ** 2 + (5 / 20) ** 2 + (5 / 20) ** 2), 0.625, 1e-12),
  },
  // ---------------------------------------------------------------- more Maths AA
  {
    id: "aa-log-equation", subject: "math-aa", level: "both", topic: "Logarithms", paper: "Paper 1 style (no calculator)", marks: 5,
    question: "Solve log2(x) + log2(x - 2) = 3, for x > 2. [5]",
    scheme: ["M1 combine with the product law: log2(x(x - 2)) = 3.", "M1 convert to exponential form: x(x - 2) = 2^3 = 8.", "A1 x^2 - 2x - 8 = 0.", "M1 solve: (x - 4)(x + 2) = 0.", "A1 x = 4, with x = -2 rejected because it is not in the domain (x > 2)."],
    check: () => near(Math.log2(4) + Math.log2(4 - 2), 3, 1e-12) && 4 * 4 - 2 * 4 - 8 === 0 && (-2) * (-2) - 2 * -2 - 8 === 0,
  },
  {
    id: "aa-arithmetic-series", subject: "math-aa", level: "both", topic: "Sequences and series", paper: "Paper 1 style (no calculator)", marks: 4,
    question: "An arithmetic sequence has first term 7 and common difference 3.\n(a) Find the 20th term. [2]\n(b) Find the sum of the first 20 terms. [2]",
    scheme: ["(a) M1 u20 = 7 + 19 x 3; A1 64.", "(b) M1 S20 = 20/2 (7 + 64) or 20/2 (2 x 7 + 19 x 3); A1 710."],
    check: () => 7 + 19 * 3 === 64 && (20 / 2) * (7 + 64) === 710 && (20 / 2) * (2 * 7 + 19 * 3) === 710,
  },
  {
    id: "aa-area-between", subject: "math-aa", level: "both", topic: "Integration: area between curves", paper: "Paper 1 style (no calculator)", marks: 5,
    question: "The curves y = x and y = x^2 enclose a region between their points of intersection.\n(a) Find the x-coordinates of the points of intersection. [2]\n(b) Find the exact area of the region. [3]",
    scheme: ["(a) M1 set x = x^2; A1 x = 0 and x = 1.", "(b) M1 area = integral from 0 to 1 of (x - x^2) dx (the line is above the curve on this interval); A1 [x^2/2 - x^3/3] from 0 to 1; A1 1/6."],
    check: () => { let a = 0; const n = 200000; for (let i = 0; i < n; i++) { const x = (i + 0.5) / n; a += (x - x * x) / n; } return near(a, 1 / 6, 1e-9) && 1 / 2 - 1 / 3 === 1 / 6 || near(1 / 2 - 1 / 3, 1 / 6, 1e-12); },
  },
  {
    id: "aa-conditional", subject: "math-aa", level: "both", topic: "Probability: conditional and independent events", paper: "Paper 1 style (no calculator)", marks: 4,
    question: "For events A and B, P(A) = 0.4, P(B) = 0.5 and P(A and B) = 0.2.\n(a) Find P(A given B). [2]\n(b) Determine whether A and B are independent, justifying your answer. [2]",
    scheme: ["(a) M1 P(A | B) = P(A and B) / P(B) = 0.2 / 0.5; A1 0.4.", "(b) M1 compare P(A) P(B) = 0.4 x 0.5 = 0.2 with P(A and B) = 0.2 (or P(A | B) = P(A)); R1 they are equal, so A and B are independent (a conclusion with no comparison earns no mark)."],
    check: () => near(0.2 / 0.5, 0.4, 1e-12) && near(0.4 * 0.5, 0.2, 1e-12),
  },
  {
    id: "aa-binomial-dist", subject: "math-aa", level: "both", topic: "The binomial distribution", paper: "Paper 2 style (calculator allowed)", marks: 4,
    question: "A factory makes bulbs and 30% of them are faulty, independently. A box holds 10 bulbs. Let X be the number of faulty bulbs in a box.\n(a) State the distribution of X. [1]\n(b) Find P(X = 3). [1]\n(c) Find the probability that more than 3 bulbs in a box are faulty. [2]",
    scheme: ["(a) A1 X ~ B(10, 0.3).", "(b) A1 0.267 (3 s.f.).", "(c) M1 P(X >= 4) = 1 - P(X <= 3); A1 0.350 (3 s.f.). A calculator setup (the function used and its parameters) should be written down."],
    check: () => { const C = (n: number, k: number) => { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; }; const pmf = (k: number) => C(10, k) * 0.3 ** k * 0.7 ** (10 - k); return near(pmf(3), 0.2668, 0.0001) && near(1 - [0, 1, 2, 3].reduce((a, k) => a + pmf(k), 0), 0.3504, 0.0001); },
  },
  {
    id: "aa-vector-angle", subject: "math-aa", level: "HL", topic: "Vectors: scalar product", paper: "Paper 1 style (no calculator)", marks: 4,
    question: "Let a = (1, 2, 2) and b = (2, -1, 2) as column vectors.\n(a) Find a . b (the scalar product). [1]\n(b) Find the exact value of the cosine of the angle between a and b. [2]\n(c) Hence find the angle, in degrees, correct to 3 significant figures. [1]",
    scheme: ["(a) A1 a . b = 2 - 2 + 4 = 4.", "(b) M1 cos(theta) = a . b / (|a||b|) with |a| = 3 and |b| = 3; A1 4/9.", "(c) A1 theta = 63.6 degrees."],
    check: () => 1 * 2 + 2 * -1 + 2 * 2 === 4 && Math.hypot(1, 2, 2) === 3 && Math.hypot(2, -1, 2) === 3 && near((Math.acos(4 / 9) * 180) / Math.PI, 63.6, 0.05),
  },
  // ---------------------------------------------------------------- more Maths AI
  {
    id: "ai-exponential-double", subject: "math-ai", level: "both", topic: "Exponential models", paper: "Paper 2 style (calculator allowed)", marks: 3,
    question: "The population of a colony of bacteria is modelled by P = 500 x 1.04^t, where t is the time in hours.\n(a) State the initial population and the hourly percentage growth. [1]\n(b) Find how long it takes for the population to double. Give your answer in hours, correct to 3 significant figures. [2]",
    scheme: ["(a) A1 500 bacteria and 4% growth per hour.", "(b) M1 solve 500 x 1.04^t = 1000 (graph intersection or logarithms: t = ln 2 / ln 1.04); A1 17.7 hours."],
    check: () => near(Math.log(2) / Math.log(1.04), 17.67, 0.01) && near(500 * 1.04 ** (Math.log(2) / Math.log(1.04)), 1000, 1e-6),
  },
  // ---------------------------------------------------------------- more Physics
  {
    id: "phys-ideal-gas", subject: "physics", level: "both", topic: "B.3 Gas laws", paper: "Paper 2 style (short answer)", marks: 3,
    question: "A fixed amount of 2.0 mol of an ideal gas is held at a temperature of 300 K in a container of volume 0.020 m^3. The molar gas constant is 8.31 J mol^-1 K^-1.\n(a) Calculate the pressure of the gas. [2]\n(b) The gas is heated at constant volume until its temperature is 600 K. State the new pressure. [1]",
    scheme: ["(a) C1 pV = nRT, so p = nRT / V; A1 2.0 x 8.31 x 300 / 0.020 = 2.5 x 10^5 Pa (249 300 Pa).", "(b) A1 doubled: 5.0 x 10^5 Pa (pressure is proportional to the kelvin temperature at constant volume)."],
    check: () => near((2 * 8.31 * 300) / 0.02, 249300, 1e-6) && near((2 * 8.31 * 600) / 0.02, 2 * 249300, 1e-6),
  },
  {
    id: "phys-electron-speed", subject: "physics", level: "HL", topic: "D.3 Motion in electromagnetic fields", paper: "Paper 2 style (short answer)", marks: 3,
    question: "An electron, starting at rest, is accelerated through a potential difference of 200 V. The electron charge is 1.60 x 10^-19 C and its mass is 9.11 x 10^-31 kg. Ignore relativistic effects.\n(a) Calculate the kinetic energy gained by the electron, in joules. [1]\n(b) Calculate its final speed. [2]",
    scheme: ["(a) A1 E = qV = 1.60 x 10^-19 x 200 = 3.2 x 10^-17 J.", "(b) C1 1/2 m v^2 = qV; A1 v = sqrt(2 x 3.2 x 10^-17 / 9.11 x 10^-31) = 8.4 x 10^6 m s^-1."],
    check: () => near(1.6e-19 * 200, 3.2e-17, 1e-30) && near(Math.sqrt((2 * 3.2e-17) / 9.11e-31), 8.38e6, 0.01e6),
  },
  // ---------------------------------------------------------------- more Chemistry
  {
    id: "chem-titration", subject: "chemistry", level: "both", topic: "Titration calculations", paper: "Paper 2 style (short answer)", marks: 3,
    question: "25.0 cm^3 of sodium hydroxide solution is exactly neutralised by 20.0 cm^3 of 0.100 mol dm^-3 hydrochloric acid: NaOH + HCl -> NaCl + H2O.\n(a) Calculate the amount, in mol, of hydrochloric acid used. [1]\n(b) State the amount of sodium hydroxide that reacted. [1]\n(c) Calculate the concentration of the sodium hydroxide solution. [1]",
    scheme: ["(a) A1 0.100 x 0.0200 = 2.00 x 10^-3 mol.", "(b) A1 2.00 x 10^-3 mol (1 : 1 ratio).", "(c) A1 2.00 x 10^-3 / 0.0250 = 0.0800 mol dm^-3."],
    check: () => near(0.1 * 0.02, 0.002, 1e-12) && near(0.002 / 0.025, 0.08, 1e-12),
  },
  // ---------------------------------------------------------------- more Biology
  {
    id: "bio-surface-volume", subject: "biology", level: "both", topic: "Surface area to volume ratio", paper: "Paper 2 style (short answer)", marks: 3,
    question: "A cube-shaped cell has sides of 1 micrometre. A second cube-shaped cell has sides of 2 micrometres.\n(a) Calculate the surface area to volume ratio of each cell. [2]\n(b) Explain why the larger cell would find it harder to exchange materials with its surroundings. [1]",
    scheme: ["(a) C1 surface area = 6 x side^2 and volume = side^3; A1 the 1 micrometre cell has 6 : 1 (6 per micrometre) and the 2 micrometre cell has 24 : 8 = 3 : 1.", "(b) R1 the ratio falls as size rises, so there is less surface for each unit of volume, and diffusion distances are longer, so supply of materials and removal of waste cannot keep up."],
    check: () => (6 * 1 ** 2) / 1 ** 3 === 6 && (6 * 2 ** 2) / 2 ** 3 === 3,
  },
];

const SUBJECT_TEST: [BankSubject, RegExp][] = [
  ["math-aa", /\bmath(s|ematics)?\b[^a-z]*(aa|analysis)|\baa\b/i],
  ["math-ai", /\bmath(s|ematics)?\b[^a-z]*(ai|applications)|\bai\b/i],
  ["physics", /\bphysics\b|\bphysique\b/i],
  ["chemistry", /chem|chimie/i],
  ["economics", /econ/i],
  ["biology", /\bbio/i],
];

/** Which bank a session subject belongs to ("Math AA HL", "Physics SL"...), or undefined when the bank has none. */
export function bankSubjectOf(subject?: string): BankSubject | undefined {
  const s = String(subject || "");
  if (!s.trim()) return undefined;
  const hit = SUBJECT_TEST.find(([, re]) => re.test(s));
  if (hit) return hit[0];
  return /\bmath/i.test(s) ? "math-aa" : undefined; // an unspecified maths course falls back to AA
}

/** The questions suitable for this student's subject and level, at most `limit`. HL students get HL and shared questions; SL students get SL and shared ones. */
export function bankQuestionsFor(subject?: string, limit = 8): BankQuestion[] {
  const key = bankSubjectOf(subject);
  if (!key) return [];
  const lv = /\b(HL|SL)\b/i.exec(String(subject))?.[1]?.toUpperCase();
  return QUESTION_BANK.filter((q) => q.subject === key && (!lv || q.level === "both" || q.level === lv)).slice(0, limit);
}

/** The block added to the tutor prompt for this subject: the questions with their private mark schemes, plus how to use them. "" when there are none. */
export function bankBlock(subject?: string): string {
  const qs = bankQuestionsFor(subject);
  if (!qs.length) return "";
  return `VERIFIED PRACTICE QUESTIONS (original to Otto, not real past-paper questions; every answer was checked by code). When you want to pose an exam-style question, prefer one of these that fits the topic and the student's level over inventing one whose answer you cannot be sure of; change the numbers if they have seen it. Pose only the question text exactly as written, with its marks (never the words "QUESTION" or "MARK SCHEME", and no bold or other markup). The mark scheme is PRIVATE: never show, read out or quote it, and never give an answer from it. Use it only to mark what they say and to see which mark they lost. Say it is a practice question. EVERY number or equation the student gives for one of these questions must be compared with the scheme before you react: if the scheme says 1.8 and they say 1.2, it is wrong, however plausible it sounds, and you never say "right" to it; never confirm a value from memory when the scheme has it.
${qs.map((q) => `Q${qs.indexOf(q) + 1}. ${q.paper}, ${q.level === "both" ? "SL and HL" : q.level}, ${q.topic}, ${q.marks} marks.\nQUESTION:\n${q.question}\nMARK SCHEME (private):\n${q.scheme.map((l) => `- ${l}`).join("\n")}`).join("\n\n")}`;
}

const wordsOf = (t: string) => String(t || "").toLowerCase().replace(/[^a-z0-9. ]+/g, " ").split(/\s+/).filter((w) => w.length > 2);

/** The bank question that the conversation is about, if the tutor posed one: found by how much of the question's own wording and numbers appear in the text. */
export function findBankQuestion(text: string, subject?: string): BankQuestion | undefined {
  const pool = subject ? QUESTION_BANK.filter((q) => bankSubjectOf(subject) === q.subject) : QUESTION_BANK;
  const hay = new Set(wordsOf(text));
  let best: { q: BankQuestion; score: number } | undefined;
  for (const q of pool) {
    const w = [...new Set(wordsOf(q.question))].slice(0, 40);
    if (w.length < 6) continue;
    const score = w.filter((x) => hay.has(x)).length / w.length;
    if (score >= 0.7 && (!best || score > best.score)) best = { q, score };
  }
  return best?.q;
}

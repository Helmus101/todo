/** Two short landing lines: Pronote is built in, and it's private. Each describes something the app does. */
export function LandingDetails() {
  return (
    <section className="landing-detail" aria-label="Pronote and privacy">
      <dl className="landing-detail-list">
        <div><dt>{"Built into Pronote."}</dt><dd>{"Connect once and Otto reads your homework, tests, grades and lessons. It's read-only: nothing is ever sent or handed in for you."}</dd></div>
        <div><dt>{"Private."}</dt><dd>{"Sessions stay in your browser unless you choose to share them, voice and typed text are processed by Google, OpenAI and DeepSeek to answer you, and your Pronote login is encrypted. Export or delete your account whenever you want."}</dd></div>
      </dl>
    </section>
  );
}

/** "Is Otto right for you?": straight answers on who it suits, who should use something else, what it costs, where your data lives and how to test it. */
export function LandingFit() {
  return (
    <section className="landing-fit" aria-label="Is Otto right for you">
      <h2>{"Is Otto right for you?"}</h2>
      <div className="landing-fit-grid">
        <div>
          <h3>{"Good fit"}</h3>
          <ul>
            <li>{"You want to understand it and solve it yourself: maths, physics, chemistry, economics, languages, SAT, AP, IB, Bac."}</li>
            <li>{"You learn by talking it through, with the working on a board in front of you."}</li>
            <li>{"You keep making the same mistakes and want to find out why."}</li>
          </ul>
        </div>
        <div>
          <h3>{"Use something else when"}</h3>
          <ul>
            <li>{"You want a fast answer or a quick explanation: a normal AI assistant is quicker."}</li>
            <li>{"You need timed exam practice and marking: use past papers and mark schemes."}</li>
            <li>{"The stakes are high and personal: a human tutor."}</li>
          </ul>
        </div>
      </div>
      <dl className="landing-fit-facts">
        <dt>{"Cost"}</dt><dd>{"Free for now, with a weekly AI allowance per account. If you use it up you can ask for more."}</dd>
        <dt>{"Your data"}</dt><dd>{"Sessions, boards and drawings stay in your browser. A short record of the ideas you've worked on is kept on your account so Otto knows where you struggle on any device."}</dd>
        <dt>{"Accuracy"}</dt><dd>{"Otto is an AI and can be wrong, maths included. Check what matters against your course material. Its answers are only as good as the question it asks next."}</dd>
        <dt>{"Evidence"}</dt><dd>{"The method rests on published research on explaining out loud and retrieval practice. We haven't run an outcomes study of Otto itself."}</dd>
        <dt>{"Languages"}</dt><dd>{"English, 中文, हिन्दी, Español, Français, العربية, Português, Русский, Deutsch, 日本語."}</dd>
      </dl>
      <p className="landing-fit-test"><b>{"The fair test: "}</b>{"work three hard problems with Otto. The next day, solve three similar ones alone. If you can rebuild the reasoning yourself, it's working. If you only remember Otto's explanations, it isn't."}</p>
    </section>
  );
}

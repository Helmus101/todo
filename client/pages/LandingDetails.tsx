/** Two plain-spoken landing sections: how Otto connects to Pronote, and straight answers to the usual doubts about AI tutors.
 *  Every line describes something the app does; nothing here is a promise of results. */
export function LandingDetails() {
  return (
    <>
      <section className="landing-detail" aria-label="Pronote">
        <h2>{"Built around your Pronote"}</h2>
        <p>{"Connect Pronote once and Otto reads your homework (the cahier de texte), your upcoming tests, your grades and the lesson content your teachers publish. It starts from what is actually due, builds questions from your own lessons, and never sends or hands in anything for you."}</p>
        <p>{"Your school login is stored encrypted, only to keep the connection alive. You can disconnect Pronote at any time from Settings."}</p>
      </section>
      <section className="landing-detail" aria-label="The hard parts of AI tutoring">
        <h2>{"The hard parts of AI tutoring, answered"}</h2>
        <dl className="landing-detail-list">
          <div><dt>{"Questions first, then a real explanation."}</dt><dd>{"Otto asks before it tells. If you already know something, it stops hinting and moves on. If you're stuck after two tries, or frustrated, it stops asking, explains it plainly, then checks with a fresh example."}</dd></div>
          <div><dt>{"You do the last one alone."}</dt><dd>{"A clear explanation can feel like understanding when it isn't. Before it closes a topic, Otto gives you a new problem with no help and tells you honestly whether you did it yourself."}</dd></div>
          <div><dt>{"It tracks what you really learned."}</dt><dd>{"Otto records whether you solved something alone, after a hint, or only after an explanation, and which mistakes keep coming back, then uses that in later sessions."}</dd></div>
          <div><dt>{"It checks its maths."}</dt><dd>{"Otto works a problem out before it confirms an answer, and the arithmetic on the board is checked by code before it is written. It can still be wrong, so check what matters against your course."}</dd></div>
          <div><dt>{"Exam-style, not official."}</dt><dd>{"Practice questions follow the style of SAT, AP, IB and Bac. They are not official, and Otto doesn't claim they match a mark scheme. Use past papers and your teacher for that."}</dd></div>
          <div><dt>{"Your data stays yours."}</dt><dd>{"Sessions and boards stay in your browser. You can export or delete your account whenever you want."}</dd></div>
        </dl>
      </section>
    </>
  );
}

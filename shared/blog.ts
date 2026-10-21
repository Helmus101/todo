/** The Otto blog: evidence-based study guides. Plain data so the same posts feed the prerendered HTML (each post is a
 *  real page for search engines), the in-app pages and the sitemap. Every claim cites the study it comes from; where a
 *  number would be easy to misremember it is left out rather than guessed. */
export type Block = { t: "h2"; text: string } | { t: "p"; text: string } | { t: "ul"; items: string[] };

export interface Post {
  slug: string;
  title: string;
  description: string;
  /** ISO date of publication. */
  date: string;
  minutes: number;
  blocks: Block[];
}

export const POSTS: Post[] = [
  {
    slug: "active-recall-study-technique",
    title: "Active recall: why testing yourself beats rereading",
    description: "Rereading feels productive but teaches less than trying to remember. What the research says about practice testing, and how to use it in any subject.",
    date: "2026-10-21",
    minutes: 4,
    blocks: [
      { t: "p", text: "Most students revise by reading their notes again and highlighting. It feels like progress because the material looks familiar. Familiar is not the same as remembered, and the research on this is unusually consistent." },
      { t: "h2", text: "What the research found" },
      { t: "p", text: "In a well-known experiment, Roediger and Karpicke (2006, Psychological Science) had students read a passage and then either read it again or take a test where they had to recall it. Straight afterwards the rereaders did slightly better. A week later the students who had tested themselves remembered clearly more." },
      { t: "p", text: "A large review by Dunlosky and colleagues (2013, Psychological Science in the Public Interest) compared ten popular study techniques. Practice testing and spacing your study over time were the two rated highest in usefulness. Highlighting and rereading were rated low." },
      { t: "h2", text: "Why it works" },
      { t: "p", text: "Pulling an answer out of memory is itself what strengthens the memory, and it shows you exactly what you do not know yet. Reading again only shows you what you already recognise." },
      { t: "h2", text: "How to do it without a teacher" },
      { t: "ul", items: [
        "Close the notes and write down everything you remember about a topic. Then open them and mark what you missed.",
        "Turn each heading in your notes into a question and answer it from memory.",
        "For maths, cover the solution and do the problem from a blank page. Do not look until you are stuck for a full minute.",
        "For languages and vocabulary, cover one side of the card and say the other aloud before you flip it.",
        "Do it before you feel ready. A struggle to remember is the useful part, not a sign it is not working."
      ] },
      { t: "h2", text: "Where Otto fits" },
      { t: "p", text: "Otto asks you to explain things back in your own words instead of showing the answer first, which is recall practice by default. When you are stuck it explains, then asks again a different way so you are retrieving it, not just reading it." },
    ],
  },
  {
    slug: "spaced-repetition-how-to-stop-forgetting",
    title: "Spaced repetition: how to stop forgetting what you study",
    description: "Cramming works for tomorrow and fails for next month. How the spacing effect works, a simple review schedule, and how to fit it around school.",
    date: "2026-10-21",
    minutes: 4,
    blocks: [
      { t: "p", text: "You study a topic on Monday, feel confident, and by the next Monday half of it is gone. That is normal, and there is a well-tested way to reduce it: review the material at increasing gaps instead of all at once." },
      { t: "h2", text: "The forgetting curve and the spacing effect" },
      { t: "p", text: "Hermann Ebbinghaus described in the 1880s how quickly memories fade without review. Since then many studies have shown the spacing effect: the same amount of study spread over several sessions gives better long-term memory than one block. A review by Cepeda and colleagues (2006) pulled together hundreds of results and found the benefit is robust." },
      { t: "p", text: "The best gap depends on how long you need to remember. The longer the target, the longer the useful gap. For a test in a few weeks, gaps of days work well; for something you need next year, gaps of weeks." },
      { t: "h2", text: "A simple schedule that works for school" },
      { t: "ul", items: [
        "Study it once properly, on the day you learn it.",
        "Review it briefly the next day, from memory, not by rereading.",
        "Review again about three days later, then about a week later, then about three weeks later.",
        "If you could not recall it, shorten the next gap. If it felt easy, lengthen it.",
        "Five or ten minutes per review is enough. The point is the retrieval, not the time."
      ] },
      { t: "h2", text: "Make it part of the week" },
      { t: "p", text: "Put the reviews on the calendar next to your homework. A short flashcard session before dinner covers most of it. Exact intervals vary between students and subjects, so treat the numbers above as a starting point." },
      { t: "h2", text: "Where Otto fits" },
      { t: "p", text: "Otto turns what you got wrong into flashcards and brings them back after a delay, so the review happens without you having to schedule it." },
    ],
  },
  {
    slug: "worked-examples-learn-maths-faster",
    title: "Worked examples: how to learn a maths method faster",
    description: "When you are new to a method, studying solved examples beats grinding problems. Why this works, how to study an example properly, and when to switch to practice.",
    date: "2026-10-21",
    minutes: 4,
    blocks: [
      { t: "p", text: "Many students think the way to learn maths is to do as many problems as possible. For a method you have just met, that is often the slow way. Studying fully worked solutions first can teach you more in less time." },
      { t: "h2", text: "What the research found" },
      { t: "p", text: "Sweller and Cooper (1985) found that students who studied worked examples of algebra problems did better on later problems than students who solved the same problems themselves. The explanation from cognitive load theory is that a beginner who is searching for a method is using up working memory that could go into understanding it." },
      { t: "p", text: "It reverses with experience. Kalyuga and colleagues described an expertise reversal effect: once you know the method, worked examples add little and doing problems is better. That is why the right move is to fade out the support as you improve." },
      { t: "h2", text: "How to study an example properly" },
      { t: "ul", items: [
        "Cover the solution and try the first step yourself. Then check.",
        "For every line, say why that step is allowed and what it achieves.",
        "Write down the pattern in your own words: what kind of problem is this, and what do I do first?",
        "Redo the same example from a blank page the next day.",
        "Then try a similar problem with different numbers, with the last step left for you, then a full one on your own."
      ] },
      { t: "h2", text: "When to stop reading and start solving" },
      { t: "p", text: "When you can predict the next line before you reveal it, you are ready to practise without support. If you get stuck twice on the same step, go back to an example." },
      { t: "h2", text: "Where Otto fits" },
      { t: "p", text: "Otto works the same way: it shows a worked case with different numbers when you are stuck, then hands you the last step, then a fresh problem. The board keeps the working so you can read it back later." },
    ],
  },
  {
    slug: "self-explanation-say-why-each-step-works",
    title: "Self-explanation: say why each step works",
    description: "Students who explain solutions to themselves learn more from the same examples. What self-explanation is, what to say, and how to do it out loud.",
    date: "2026-10-21",
    minutes: 3,
    blocks: [
      { t: "p", text: "Two students read the same worked solution. One moves on. The other stops at each line and asks: why is this allowed, and what does it get me? The second student learns more, and this has been measured." },
      { t: "h2", text: "What the research found" },
      { t: "p", text: "Chi, Bassok, Lewis, Reimann and Glaser (1989, Cognitive Science) studied students learning physics from worked examples. The students who did better were the ones who spontaneously explained the examples to themselves, linking each step to the underlying principle. Later work showed that prompting students to self-explain helps." },
      { t: "h2", text: "What to say" },
      { t: "ul", items: [
        "Why can I do this? Name the rule or definition that allows it.",
        "What is this step for? How does it get me closer to the answer?",
        "What would change if a number or condition changed?",
        "Where have I seen this pattern before?"
      ] },
      { t: "h2", text: "An example" },
      { t: "p", text: "Take the line: log(x^3) = 3 log(x). A student who only reads it sees a rule. A student who self-explains says: the exponent inside a logarithm can come out as a multiplier, because a logarithm counts how many times you multiply, so x cubed is three lots of x. Now they can also see why log(x + y) does not split in the same way, which is a mistake the rule alone never prevents." },
      { t: "h2", text: "Common ways to do it badly" },
      { t: "ul", items: [
        "Paraphrasing the line instead of giving the reason: 'then I divide both sides' is a description, not an explanation.",
        "Explaining only the steps you found hard, so the easy ones hide gaps.",
        "Moving on when the explanation feels vague. A vague explanation is the signal to look the idea up or ask."
      ] },
      { t: "h2", text: "Why out loud helps" },
      { t: "p", text: "Saying it out loud makes gaps obvious: you cannot hide behind a vague feeling of understanding when you have to produce the words. If you cannot explain a step, you have found exactly what to ask about." },
      { t: "h2", text: "Where Otto fits" },
      { t: "p", text: "Otto is built around this. You talk, it asks why, and when your explanation has a hole it points at the hole instead of filling it for you." },
    ],
  },
  {
    slug: "learn-from-mistakes-error-log",
    title: "How to learn from your mistakes with an error log",
    description: "A mistake you only correct is a mistake you repeat. How to keep a short error log that sorts your errors by cause and fixes the ones that keep coming back.",
    date: "2026-10-21",
    minutes: 4,
    blocks: [
      { t: "p", text: "After a test, most students look at the marks, glance at the right answers and move on. The mistakes that cost you marks tend to be the same few, coming back in new forms. A short error log is the cheapest way to stop that." },
      { t: "h2", text: "Why feedback needs a next step" },
      { t: "p", text: "Hattie and Timperley (2007, Review of Educational Research) concluded that feedback is most useful when it tells you where you are going, how you are doing, and what to do next. A log turns a one-off correction into that last part: a specific action for next time." },
      { t: "h2", text: "What to write down" },
      { t: "ul", items: [
        "The question, in a line.",
        "What you did, and what was right.",
        "The cause of the error, in one of three groups: a missing idea, a wrong or unfamiliar method, or a slip (arithmetic, sign, misreading).",
        "The fix for that cause, for example: relearn the rule, redo two similar problems, or add a final check for signs."
      ] },
      { t: "h2", text: "How to use it" },
      { t: "p", text: "Once a week, read the log and count the groups. If most of your errors are slips, practise checking. If they are missing ideas, go back to the topic. If one particular mistake shows up three times, it deserves its own practice session." },
      { t: "p", text: "Redo each logged question without looking, a week later. If you get it right, cross it off. If not, it stays." },
      { t: "h2", text: "An example entry" },
      { t: "p", text: "Question: expand log(x^3 y / z). I wrote 3 log x + log y - log z, but the question had y to the power one half, and I dropped the half. Cause: a slip, I copied the exponent wrongly. Fix: underline every exponent in the question before I start, and tick them off at the end. Three entries like this in a week tell you the problem is checking, not the topic." },
      { t: "h2", text: "Where Otto fits" },
      { t: "p", text: "Otto notices repeat mistakes during a session, shows them in Settings with review dates, and brings them back later so they do not sit in a notebook." },
    ],
  },
  {
    slug: "interleaved-practice-mix-your-problems",
    title: "Interleaved practice: why mixing problem types helps you on the test",
    description: "Doing ten of the same problem feels easy and prepares you badly. What interleaving is, what the maths studies found, and how to build a mixed practice set.",
    date: "2026-10-21",
    minutes: 4,
    blocks: [
      { t: "p", text: "Textbooks group problems by topic, so you do ten on one method, then ten on the next. That makes practice feel smooth, but exams do not tell you which method to use. Choosing the method is part of the skill." },
      { t: "h2", text: "What the research found" },
      { t: "p", text: "Rohrer and Taylor (2007) compared students who practised maths problems in blocks with students who practised the same problems mixed together. During practice the blocked group looked better. On a test a week later the mixed group scored far higher. Later classroom studies by Rohrer and colleagues found similar benefits in school mathematics." },
      { t: "h2", text: "Why it works" },
      { t: "p", text: "When problem types are mixed you have to work out which one you are looking at before you solve it, and you notice what makes one type different from another. In a block you can just repeat the last move." },
      { t: "h2", text: "How to build a mixed set" },
      { t: "ul", items: [
        "After you can do a method with support, put one problem of it into a set with problems from other topics you have studied.",
        "Shuffle the order. Do not tell yourself in advance which topic each is.",
        "Before solving, write one line: what kind of problem is this and why?",
        "Come back to old topics every week, not only the one in class."
      ] },
      { t: "p", text: "A small example for a logarithms unit: instead of ten expand-the-log questions in a row, do one expand, one solve for x, one change of base, one exponential growth word problem and one domain check, then repeat the set in a new order. Each question makes you decide which tool applies, and that decision is the part the exam tests." },
      { t: "p", text: "Expect it to feel harder and slower. That difficulty is what helps, and the improvement shows up later, on the test." },
      { t: "h2", text: "Where Otto fits" },
      { t: "p", text: "After two solved problems of the same kind, Otto changes the format or brings back an earlier idea, so you are not drilling one pattern." },
    ],
  },
  {
    slug: "how-to-write-a-history-essay-argument",
    title: "How to build an argument in a history essay",
    description: "A history essay is judged on its argument, not on how much you know. A clear way to plan claim, evidence, analysis and counter-argument, with a short example.",
    date: "2026-10-21",
    minutes: 5,
    blocks: [
      { t: "p", text: "Many history essays fail in the same way: they tell the story and never answer the question. Marks go to an argument, a clear answer that is defended with evidence and tested against another view." },
      { t: "h2", text: "Start with a claim you can defend" },
      { t: "p", text: "Turn the question into a one-sentence answer before you write anything. For example, to the question of whether the Treaty of Versailles was the main cause of the Second World War, a weak answer is that it was a cause. A claim you can defend is: it created grievances that Hitler used, but it was the Depression that turned them into votes." },
      { t: "h2", text: "Each paragraph: claim, evidence, analysis, link" },
      { t: "ul", items: [
        "Claim: the point of this paragraph, one sentence, tied to your answer.",
        "Evidence: a specific fact, date, source or figure, not a general statement.",
        "Analysis: explain how the evidence supports the claim, and why it matters. This is where most marks are won or lost.",
        "Link: say what this adds to your answer to the question."
      ] },
      { t: "h2", text: "Test it against the strongest objection" },
      { t: "p", text: "Ask what a historian who disagrees would say, and answer it in the essay. In the example, the objection is that the Depression came a decade later and Germany had already recovered somewhat. A good response concedes that point and explains why the treaty still mattered. Acknowledging a counter-argument and weighing it shows you are thinking, not reciting." },
      { t: "h2", text: "Weigh causes, do not list them" },
      { t: "p", text: "Rank the factors and justify the order: which mattered most, which only mattered because of another, which was a trigger and which was a long-term cause. A ranking with reasons is an argument. A list is a description." },
      { t: "h2", text: "Check your sources honestly" },
      { t: "p", text: "Say who wrote a source, when and why, and what that does to its value as evidence. Never invent a quotation or a page number. If you are not sure of a fact, check it or leave it out." },
      { t: "h2", text: "Where Otto fits" },
      { t: "p", text: "In a humanities session Otto acts as a discussion partner. It asks for your claim and your evidence, raises the strongest objection, and gives feedback on your own paragraph without rewriting it for you." },
    ],
  },
];

export const postBySlug = (slug: string): Post | undefined => POSTS.find((p) => p.slug === slug);
export const postPath = (p: Pick<Post, "slug">) => `/blog/${p.slug}`;

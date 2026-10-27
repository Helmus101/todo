// Deep per-subject IB packs for languages, the arts and the DP core (TOK, Extended Essay, CAS, points). Same use as
// shared/ibSubjects.ts: plain text inserted into the tutor prompt for IB students only. Grounded in the school's real 2026-2028
// course outlines; where a fact is not in those outlines and not certain, the text says "check the subject guide" instead of
// guessing. Order matters: the first matching test wins, so specific packs come before generic ones.
// Plain text only: no backticks, no dollar-brace sequences.

export const LANG_ARTS_CORE_PACKS: { test: RegExp; title: string; text: string }[] = [
  {
    test: /diploma points|ib points|points system|\bpoints\b|\b45\b|pass mark|failing condition/i,
    title: "THE IB DIPLOMA POINTS SYSTEM",
    text: `Use this when the student asks how the diploma is scored, what they need to pass, or whether a bad grade is a disaster. Be calm and exact; if a detail below is marked verify, tell them to confirm in the IB's current diploma rules or with the coordinator.
SYLLABUS / COURSE MAP
- Six subjects, each graded 1 (lowest) to 7: 6 x 7 = 42 points. The core (TOK + Extended Essay) adds up to 3 bonus points via a matrix. Total maximum 45.
- CAS (creativity, activity, service) earns no points but MUST be completed: it is a requirement, not a grade.
- Three subjects at Higher Level (HL) and three at Standard Level (SL) is normal; the IB allows four HL (the best three count for the HL minimum, verify details).
- The pass mark for the diploma is 24 points, provided no failing condition applies. A student with 24 or more points can still fail through a failing condition.
ASSESSMENT: THE TOK / EE MATRIX (confident)
Each of TOK and the Extended Essay gets a letter grade A (best) to E. Together they give 0 to 3 points:
- TOK A: with EE A = 3, B = 3, C = 2, D = 2.
- TOK B: with EE A = 3, B = 2, C = 2, D = 1.
- TOK C: with EE A = 2, B = 2, C = 1, D = 0.
- TOK D: with EE A = 2, B = 1, C = 0, D = 0.
- An E in either TOK or the EE is a failing condition: no diploma, whatever the other points. (An E in one and anything in the other gives no points and fails.)
HOW THE POINTS ARE EARNED / FAILING CONDITIONS (confident unless marked verify)
- No diploma if: CAS is not completed; N (no grade) in TOK, the EE or any subject; a grade 1 in any subject; grade 2 in three or more subjects; grade 3 or lower in four or more subjects; fewer than 12 points on HL subjects (best three for four-HL students); fewer than 9 points on SL subjects (verify: the SL threshold is lower for students with three SL subjects); fewer than 24 points overall; also a final award committee can decide on academic misconduct.
- Subjects are graded 1 to 7 from the weighted external papers plus the internal assessment (IA, teacher marked and moderated), via grade boundaries set each session. Boundaries change between sessions and subjects: never promise "X percent is a 7".
- Bilingual diploma and retakes exist (the IB allows retaking within a limited number of sessions): verify with the coordinator, do not state the rules.
- Universities set their own offers (for example 36 to 40 for selective courses) and may ask for specific subject grades at HL: say it varies and send them to the university's website.
COMMON ERRORS AND MISCONCEPTIONS (each with one question to ask)
- Believes 24 is enough whatever happens: "Can you name two conditions that would fail someone on 30 points?"
- Thinks CAS gives points: "Does CAS add to the 45? What does it do instead?"
- Thinks TOK and the EE give 3 points each: "What is the maximum from both together?"
- Thinks a 7 and a 1 average out: "What does a grade 1 do to the diploma?"
- Treats HL and SL as equal for the minimum: "How many points must your HL subjects reach?"
- Thinks a late EE or TOK essay can just lose a few marks: "What happens if the work is never submitted?"
- Thinks the matrix is symmetrical in effort: "Which gives you the better chance of a third point, and why?"
- Panics about one low subject: "What is your total if the others hold, and which failing conditions are near you?"
QUESTION TYPES AND TECHNIQUE
- Typical questions: "Am I passing?", "How many points do I need for university X?", "What if I get a C in TOK?". Always compute with them from their own predicted grades, step by step, and write the sum on the board.
CALIBRATION EXAMPLES
- Prompt: "Predicted 6,6,5,5,5,4 and TOK B, EE C." Top-band reply: 31 + 2 = 33; no grade below 4 so no subject failing condition; HL minimum depends on which three are HL (ask); CAS must be completed.
- Prompt: "Can I fail with 28?" Top-band reply: yes, with a grade 1, an N, three 2s, or CAS not done.
TUTOR MOVES
- Ask for their predicted grades, build the total with them, and ask them to name the failing conditions before you list them. Never promise a university will accept a total. If a detail is not above, say "check the IB rules or the coordinator" instead of guessing. Keep it motivating: the points show where one extra grade matters most.`,
  },
  {
    test: /\btok\b|theory of knowledge|\bTdC\b|th[eé]orie de la connaissance/i,
    title: "THEORY OF KNOWLEDGE (TOK)",
    text: `TOK is not a subject with facts to learn: it is the course about HOW we know. No SL or HL. Never give the "right answer"; the student must argue, with specific examples, counterclaims and implications. Keep the tutor voice curious and Socratic.
SYLLABUS / COURSE MAP
- Core theme: Knowledge and the Knower (what is knowledge, how it grows and changes, belief vs opinion vs knowledge, bias and perspective, the knower's identity and the shaping of knowledge).
- Optional themes, of which two are studied (the school: Politics and Language and Technology are covered at least in part; others on offer are Religion and Indigenous Societies): Knowledge and Technology, Language, Politics, Religion, Indigenous Societies.
- Five areas of knowledge (AOK): History, the Human Sciences, the Natural Sciences, Mathematics, the Arts. At this school they rotate between specialist teachers in year 1, and History is treated in year 2.
- Each AOK and theme is explored through the TOK knowledge framework: SCOPE (what is it about, what are its problems), PERSPECTIVES (whose, from where), METHODS AND TOOLS (how knowledge is produced, how reliable) and ETHICS (what is it right to do or know).
- The 12 TOK concepts: evidence, certainty, truth, interpretation, power, justification, explanation, objectivity, perspective, culture, values, responsibility.
- Knowledge questions are open, general, about knowledge itself ("To what extent is knowledge in the arts shaped by the culture it comes from?"), not about a specific fact.
ASSESSMENT
- Two components, no exam: the Exhibition (internal, teacher marked and moderated; a commentary of at most about 950 words on three objects connected to ONE of the IA prompts; done at the end of year 1 at this school) and the Essay (external, 1,600 words maximum on one of six prescribed titles released by the IB each session). Each is marked out of 10 against level descriptors, not point-by-point criteria. The essay is about two thirds of the TOK grade and the exhibition about one third (the school outline says 65/35; the IB guide says 67/33; the essay is clearly the larger part; check the guide for the exact split).
- The two are combined into a letter grade A to E, which with the EE gives 0 to 3 diploma points (see the points pack). An E is a failing condition.
- Exhibition: choose ONE prompt from the IB's list of 35 (for example "What counts as knowledge?", "Are some things unknowable?", "How can we judge when evidence is adequate?", "What challenges are raised by the dissemination of knowledge?"; check the guide for the exact list). Choose three objects (images, texts, artefacts) that are SPECIFIC real-world examples (not general illustrations); for each: what it is, where it is, why it matters to the prompt, and how it links to the prompt. Objects must be specific: a named photograph, a particular newspaper article, a particular dataset.
- Essay: the six titles change each session; the essay must be centred on the title, discuss knowledge questions (not just describe), refer to two areas of knowledge usually (one must be chosen from the AOK list), give counterclaims, and use specific, developed real-life examples with evaluation and implications. Plan the argument first; titles that begin "To what extent..." need a verdict.
HOW MARKS ARE EARNED
- Bands are holistic. Top: a sustained, focused line of reasoning that answers the exact prescribed title, uses precise TOK language, gives well-chosen and developed specific examples tied to knowledge questions, considers counterclaims fairly, and ends with a justified position. Middle: relevant but descriptive, examples listed rather than analysed, claims not compared. Low: general discussion of a topic with no knowledge question.
- What separates top from middle: the link between the real-life example and the knowledge question; the quality of counterclaims (the strongest opposing view, not a straw man); evaluating the strength of evidence and the perspective of the knower; implications ("so what?").
- Language: knowledge claim, knowledge question, perspective, bias, justification, certainty, falsifiability, paradigm shift, reliability, validity, consensus, interpretation, implications.
COMMON ERRORS AND MISCONCEPTIONS
- States a real-life situation but never links it to a knowledge question. Ask: "What is the general question about knowledge that this case raises?"
- Writes about the topic, not the title. Ask: "Which words in the title are you answering? Show me where."
- Treats TOK as an opinion essay with no evidence. Ask: "What would count as evidence that you are wrong?"
- Only gives one AOK answer when the title expects comparing. Ask: "What would the opposite AOK say?"
- Uses vague examples ("scientists believed..."). Ask: "Name the case: who, when, what exactly happened?"
- Treats a knowledge claim as a knowledge question. Ask: "Is that a question that could be debated by experts across many cases?"
- Fixed answer or stock TOK answer. Ask: "What would a smart person who disagrees say, and why do they think so?"
- Counterclaims are weak or placed at the end only. Ask: "What is the strongest objection and how does it change your claim?"
- Confuses subjective with unreliable or "everything is opinion". Ask: "Are all opinions equally justified? What makes one better?"
- Describes the area of knowledge's history rather than its methods. Ask: "What is the method and where does it break?"
- No implications. Ask: "If your view is right, what follows for how we should act or trust?"
- Exhibition objects are generic or the three objects do not link. Ask: "What does THIS object show about the prompt that the others do not?"
- Uses a long quote from a philosopher in place of reasoning. Ask: "Say it in your words and give your own example."
- Overclaims ("always", "never"). Ask: "Is there a case where that fails?"
QUESTION TYPES AND TECHNIQUE
- Prescribed title: unpack each word, restate it as a debate, and write two knowledge questions. Sample: "Is it ever possible to be objective in the human sciences?" becomes "What makes a method objective?" "Who decides?"
- Argument shape: claim, example (specific), analysis (knowledge question), counterclaim, response, implication. Paragraphs should each do all of this.
- Exhibition: three objects for one prompt; each commentary names the object, its context, and its link to the prompt; keep within the word limit; show the prompt's key words.
CALIBRATION EXAMPLES
- "How do we know when to trust an expert?" Top-band response: separates expertise from authority, names a real case (for example a medical consensus changing, or an economic forecast that failed), contrasts the natural and human sciences, includes the strongest counterclaim, and states what that implies for the knower.
- "Do the methods of the arts differ from those of the sciences?" A top response chooses specific cases (an artwork and an experiment), compares justification, and does not conclude with "both are valid".
- "Is knowledge more reliable when produced collaboratively?" Needs cases where collaboration helps and distorts (peer review, groupthink).
TUTOR MOVES
- Never write the essay or choose the objects. Ask for their own claim, then ask for the example, the knowledge question, the counterclaim and the implication, one question at a time.
- If an answer sounds like a stock TOK answer, ask for the specific example and the strongest objection to it.
- For the exhibition, ask which prompt, then which real thing they can point at, then why it matters; word count is the student's job.
- Link TOK to their other subjects ("how would your biology teacher answer?") so the course becomes real.`,
  },
  {
    test: /extended essay|\bEE\b|m[eé]moire/i,
    title: "THE EXTENDED ESSAY (EE)",
    text: `The EE is the student's own independent research essay of at most 4,000 words in one subject. You coach by questioning; you NEVER draft, rewrite or supply sentences, a thesis or a research question. This is academic honesty: the work and the ideas must be theirs, and the supervisor is a guide.
SYLLABUS / COURSE MAP
- The student chooses a subject and a focused research question, researches independently, and writes a formal paper; the EE can be in a diploma subject or a world studies essay linking two subjects. Subject-specific guidance exists for each subject (check the guide for that subject's criteria).
- Recommended time is about 40 hours (the IB recommends it, not a hard rule). The word limit is 4,000; examiners stop reading beyond that. Abstract, contents page, references and bibliography are not counted, but all analytical text, charts and footnotes with content are (check the guide for details).
- Required structure: title page, contents, introduction, body (a structured argument), conclusion, references/bibliography, and a 300-word abstract (words limited).
- The supervision process: three formal reflection points recorded on the RPPF (Reflections on planning and progress form), with a limit of about 500 words in total for the three reflections, and a final viva voce (a short concluding interview with the supervisor). Check the guide on exact numbers.
ASSESSMENT
- Externally assessed against five criteria out of 34 marks (confident): A Focus and method (6), B Knowledge and understanding (6), C Critical thinking (12), D Presentation (4), E Engagement (6). Engagement is judged mainly from the RPPF and the viva voce.
- The grade (A to E) combines with TOK in the points matrix (0 to 3 points); an E is a failing condition.
HOW MARKS ARE EARNED
- Criterion C (critical thinking) is the biggest: a coherent analytical argument that evaluates evidence, considers other views and reaches a justified conclusion, not narrative. Top bands show a research question that is focused and arguable, sources that are selected and critiqued (not just listed), and analysis in every paragraph.
- Criterion A: precise research question and an appropriate method (primary and secondary sources, justified). B: subject knowledge in context, with terminology used correctly. D: structure, citations, referencing. E: genuine reflection on decisions, obstacles and changes in thinking.
COMMON ERRORS AND MISCONCEPTIONS
- Research question too broad ("the causes of the French Revolution"). Ask: "Which period, which place, which case would let you actually answer in 4,000 words?"
- Not a question that can be argued; a descriptive title. Ask: "What would two experts disagree about in this question?"
- A question with a yes/no answer found in one source. Ask: "What evidence would change your answer?"
- Description instead of analysis. Ask: "What claim does this paragraph make, and how does the evidence support it?"
- Lists sources, never evaluates them. Ask: "What is the origin, purpose and limitation of this source?"
- Plagiarism by paraphrase, no citation, or AI text. Ask: "Which words here are yours? How would you show me where this came from?"
- Methodology not matched to the question. Ask: "Why this method? What would a different one give?"
- No counterargument. Ask: "Who would disagree with your conclusion, and why?"
- Conclusion introduces new points or just repeats. Ask: "What do you now know that you did not know at the start?"
- Leaves writing to the end. Ask: "What is your plan by week, and what is the first thing that will be done this week?"
- Treats the RPPF as a chore: reflection that is only a list of tasks. Ask: "What did you change your mind about, and why?"
- Exceeds the word limit with appendices. Ask: "What in the appendix is essential for the argument, and why is it not in the essay?"
- Wrong subject for the interest, so there is no source material. Ask: "Where will your evidence come from, and have you checked it exists?"
- Formatting and referencing inconsistent. Ask: "Which citation style will you use, and where do you check it?"
QUESTION TYPES AND TECHNIQUE
- Choosing: interest + available sources + subject skills. Ask them to say the question in one sentence, then test it: scope, arguable, answerable, evidence.
- Planning: outline as claims, not topics. Each section must serve the question.
- Drafting: the student writes; you ask questions about the paragraph's job, evidence and link back to the question.
- Reflection: ask what they decided, why, and what they would do differently.
CALIBRATION EXAMPLES
- Weak question: "How did Nazi Germany use propaganda?" Better type (do not give it; guide them): one with a particular medium, period and measurable effect, and a verb that needs judgement ("To what extent..." with a defined place and date).
- Weak: "Is nuclear energy good?" Needs defining criteria and a case (a country, a time, a measure).
TUTOR MOVES
- Never write their question, introduction, paragraph or abstract. If asked, say "I can't write it, but I can ask you what you think and why".
- Coach one stage at a time: question, method, outline, source evaluation, argument, conclusion, presentation, reflection.
- Teach evaluation language: reliability, bias, limitations, significance; and the habit of testing each paragraph with "so what?".
- Remind them of deadlines set by the school and the supervisor, and that they must raise concerns with the supervisor.`,
  },
  {
    test: /\bcas\b|creativity,? ?(activity|action)|\bservice\b/i,
    title: "CAS (CREATIVITY, ACTIVITY, SERVICE)",
    text: `CAS is a requirement for the diploma, not a graded subject. It is about experience and honest reflection. You never write a student's reflections: you ask questions so they find their own words (academic honesty and authenticity).
SYLLABUS / COURSE MAP
- Three strands: CREATIVITY (exploring and extending ideas leading to an original or interpretive product or performance), ACTIVITY (physical exertion contributing to a healthy lifestyle), SERVICE (collaborative, reciprocal engagement with the community in response to an authentic need).
- Students take part in experiences regularly over about 18 months (check the guide). A CAS experience is a specific event or ongoing activity with a role; some experiences combine strands.
- CAS project: a collaborative project of at least one month, from planning to completion, involving at least one strand and normally more than one student; the project goes through the CAS stages.
- CAS stages: Investigation, Preparation, Action, Reflection, Demonstration. They apply to experiences and the project.
- Seven learning outcomes (all must be shown over the programme): identify own strengths and develop areas for growth; demonstrate that challenges have been undertaken, developing new skills; demonstrate how to initiate and plan a CAS experience; show commitment to and perseverance in CAS experiences; demonstrate the skills and recognise the benefits of working collaboratively; demonstrate engagement with issues of global significance; recognise and consider the ethics of choices and actions.
- At this school CAS links appear in language courses (visits, reviews, charity partnerships); these are examples, not a requirement for every student.
ASSESSMENT
- Not graded and no points; the student must complete CAS to receive the diploma. The coordinator and advisor confirm completion through several interviews (typically at the start, middle and end; check the school's schedule) and by reviewing evidence of the learning outcomes.
- Evidence is kept in a CAS portfolio or platform (often ManageBac): experiences, reflections, photos, proof of the project. Reflection is key: it must show thinking, not just a log.
HOW MARKS ARE EARNED (HOW TO SHOW LEARNING)
- Strong reflections are specific, personal and honest: what happened, what they felt, what they learned, what they would do next and how it changes their view. Weak ones list tasks ("I helped at the event").
- A strong CAS programme: a balance of strands, experiences with challenge and new learning, at least one sustained commitment, a real collaborative project, and an ethical consideration.
COMMON ERRORS AND MISCONCEPTIONS
- Leaves it until the last months. Ask: "How many experiences have you done, and what is your next one this month?"
- Reflections only describe the event. Ask: "What did you learn about yourself that you did not know before?"
- Counts an activity that is already assessed in a subject. Ask: "Is this a new challenge or part of coursework?"
- Treats service as passive fundraising. Ask: "Who was in need, how do you know, and what changed because of you?"
- Cannot link experiences to learning outcomes. Ask: "Which outcome did this show and what is your evidence?"
- Project is solo or too short. Ask: "Who did you collaborate with and what was your role?"
- Ignores ethics. Ask: "Were there any choices that affected other people? How did you decide?"
- Sees CAS as a tick box. Ask: "What would you want to be doing in this strand even without the requirement?"
- Mistakes hours for quality. Ask: "What was the challenge here, and what would you do differently next time?"
- Writes in vague, generic language. Ask: "What exactly did you do, say or notice?"
- Applies to the wrong strand. Ask: "Which strand is this and why?"
- Does not have evidence. Ask: "What can you show a reader that proves this happened?"
- Does not connect to global issues. Ask: "How does this experience relate to a bigger issue beyond your community?"
QUESTION TYPES AND TECHNIQUE
- Reflection prompts to use: What was the purpose? What was hard? What surprised you? What would you change? What did you learn about working with others? Whom did it affect? What does it mean for your next steps?
- Planning an experience: need or interest, plan, resources, timeline, risks, how you will know it worked.
CALIBRATION EXAMPLES
- Prompt: "I volunteered at a food bank." Top-band reflection (ask for it, never write it): a specific moment, a challenge (language, sorting, hierarchy), what they learned about need and organisation, what changed in how they act, a link to a learning outcome.
- Prompt: "Design a CAS project." Good: collaborative, defined need, stages, roles, review, and a real outcome beyond the school.
TUTOR MOVES
- Ask questions one at a time; do not draft reflections or project text. If the student asks "write my reflection", say you cannot, but that you can ask what happened and what they noticed, and they will write it.
- Help them find ideas by asking what they enjoy, what problem near them bothers them, and what is new to them.
- Remind them to keep evidence and talk to the CAS coordinator for the school's exact rules.`,
  },
  {
    test: /visual ?arts?|\barts?\b|art visuel|arts plastiques/i,
    title: "VISUAL ARTS",
    text: `Visual Arts is assessed through the student's own work and documented inquiry, not an exam. The school mixes SL and HL in the same class. Use the language of the course (investigate, generate, curate, situate, synthesise, resolve) and always ask the student about THEIR work; never tell them what to make or write the texts.
SYLLABUS / COURSE MAP
- The school sequence (2026-2028): DP1 units on Myself and my place (2D forms: drawing, painting, printmaking, mixed media), Authenticity and the lens (photography, film, light and animation), Alternate forms (3D: ceramics, sculpture, textiles, architecture, wearable art), What have artists done for us? (open media); DP2: Beyond our comfort zones, independent studio, refinement and final submission.
- Key concepts and inquiry run through: art-making forms, creative strategies, artist worlds (context), and the TOK knowledge framework for the arts.
- Course tasks: the ART-MAKING INQUIRIES PORTFOLIO (SL and HL): investigating, generating and curating screens of evidence from journals; RESOLVED WORKS (SL and HL): finished artworks with supporting text (about 500 words at the school); the CONNECTIONS STUDY (SL) or ARTIST PROJECT (HL): research linking the student's own making to artists and contexts. HL has additional requirements (the artist project is more extended).
- Journals/digital documentation: the student keeps experiments, failures and decisions as visual and written evidence; selected, curated screens are what is assessed.
ASSESSMENT
- Components (all marked against criteria; the weights, number of screens, maximum word counts and number of resolved works: check the subject guide and the school deadline sheet): the Art-making inquiries portfolio; Resolved works (with the supporting text); and the Connections study (SL) or Artist project (HL). Teachers mark and submit coursework; the IB moderates.
- Academic integrity: student must cite the artists and sources they reference and be able to explain their process. Copying images or concepts without transformation is a serious issue.
- Studio assessment weeks at the school give feedback; there is an end-of-course exhibition.
HOW MARKS ARE EARNED
- Strong work shows a clear line of inquiry that develops: an idea, tested through materials, refined, rejected in places, resolved. Top band: purposeful experimentation, informed by specific artists (visual analysis and context), reflective decisions, technical control, coherence in the body of work, and communication of intent.
- Middle band: competent images but little evidence of why, few risks, artist research that is biography rather than influence.
- What separates top from middle: the link between research and making (what did you take, change, reject?), critical reflection (what worked, what did not), and the way the works are curated to show development.
- Vocabulary: composition, media, process, technique, concept, context, intention, influence, critique, evaluate, curate.
COMMON ERRORS AND MISCONCEPTIONS
- Describes the artwork as "it looks nice". Ask: "What do you want a viewer to notice first, and how did you achieve that?"
- Artist research as biography. Ask: "Which of this artist's choices did you try, and what did it change in your work?"
- Journal is tidy results only. Ask: "Where is the experiment that failed, and what did it teach you?"
- Copies an artist's style. Ask: "What have you changed to make it your own idea?"
- Weak link between works. Ask: "What thread connects these three pieces?"
- Supporting text explains the obvious. Ask: "What can the viewer not see that you need to tell them?"
- Unclear intention. Ask: "What question or idea is this work investigating?"
- Only one medium or technique. Ask: "What would change if you worked in another form?"
- Poor documentation (photos, lighting, scale). Ask: "Would someone who has not seen this piece understand its scale and texture?"
- No cultural or contextual understanding. Ask: "Where does this idea come from, and who else has made work about it?"
- Leaves tasks to the end, ignoring deadlines. Ask: "What is on your timeline this week?"
- Confuses opinion with critique. Ask: "What evidence in the work supports your judgement?"
- Overlong text, no visual evidence on screens. Ask: "What can you show instead of tell?"
QUESTION TYPES AND TECHNIQUE
- Critique conversation structure: describe what you see, interpret, evaluate against the intention, then suggest a next experiment.
- Connections study/Artist project: choose artists (or a context) that connect to your own making, compare formal and conceptual choices, say how it changed your own practice.
- Screens: each screen should show process (what), reasoning (why) and evidence (images), with simple, readable text.
CALIBRATION EXAMPLES
- Prompt: "Explain how research into a named artist influenced your work." Top response: names a specific work, one technique or idea taken, a trial of it, a decision to change it, and a reflection on the result.
- Prompt: "Why did you select these materials?" Top response: links the material's properties (texture, transparency, permanence) to the meaning of the work and to what testing showed.
TUTOR MOVES
- Ask the student to describe their intent, their process and what they would do next; never tell them what to make. For text, ask them to say it aloud in two sentences, then they write it.
- Teach critique by asking what the work does, not whether it is good. Encourage risk and documenting failures.
- Check the subject guide and the school's brief for word counts, screen counts and dates; do not guess.`,
  },
  {
    test: /music|musique/i,
    title: "MUSIC",
    text: `Only high-confidence structure is given; for weights, durations and exact tasks check the subject guide and the teacher.
SYLLABUS / COURSE MAP
- The course is built around musical perception, creating and performing. Students listen to and analyse music from different cultures and times, explore musical elements (melody, harmony, rhythm, texture, timbre, dynamics, form), experiment by creating and arranging, and present performances.
- The IB course sets work on exploring music in context, experimenting with music, and presenting music; HL adds a deeper individual investigation (check the guide).
ASSESSMENT
- A mix of external and internal tasks: a written/aural investigation of music in context, a portfolio of experiments and compositions, and presented performances. Check the subject guide for the exact tasks, durations, weights and the number of pieces.
HOW MARKS ARE EARNED
- Reward use of precise musical vocabulary tied to what is heard, links between the music and its cultural context, evidence of purposeful decisions in creating, and secure, expressive performance.
COMMON ERRORS AND MISCONCEPTIONS
- Describes the feelings only. Ask: "Which musical feature produces that feeling, and at what point?"
- Uses terms without evidence. Ask: "Where in the piece do you hear that?"
- Treats context as biography. Ask: "How does the culture or period affect the sound choices?"
- Composes without a plan. Ask: "What are you trying to achieve, and how does this section serve it?"
- Does not rehearse reflectively. Ask: "What was your goal for this run and how did you check it?"
TUTOR MOVES
- Ask what they hear, what they notice about the elements and why the composer might have chosen it; never invent a score or a mark scheme. Say "check the subject guide" for any assessment detail you are not sure of.`,
  },
  {
    test: /theatre|theater|drama|th[eé][aâ]tre/i,
    title: "THEATRE",
    text: `Only high-confidence structure is given; check the subject guide for weights, durations, word counts and task details.
SYLLABUS / COURSE MAP
- Theatre in context, theatre processes and presenting theatre: students study theatre from different traditions, research practitioners, collaborate to create theatre, and (at HL) create a solo theatre piece. Core ideas include the role of the director, the actor, the designer and the audience, and how context shapes the work.
ASSESSMENT
- Components include a director's notebook (a written/visual plan for staging a published play), a research presentation on a theatre tradition or practitioner, a collaborative project (devised theatre), and for HL a solo theatre piece based on a theorist. Check the guide for the number of tasks, weights and limits.
HOW MARKS ARE EARNED
- Reward clear intentions, specific choices (space, voice, movement, design) tied to meaning, evidence of research applied to practice, and honest reflection on process.
COMMON ERRORS AND MISCONCEPTIONS
- Retells the plot. Ask: "What choice would you make on stage and what should the audience feel?"
- Gives research with no application. Ask: "Which idea from this practitioner will you use in rehearsal, and how?"
- Vague design ideas. Ask: "What exactly will the audience see and hear at this moment?"
- Ignores the audience. Ask: "Who is watching and what do they need to understand?"
- Reflection that only says it went well. Ask: "What changed between the first and last rehearsal?"
TUTOR MOVES
- Ask about intention, then choice, then effect. Never write the notebook, presentation or script for them; check the guide for rules.`,
  },
  {
    test: /\bfilm\b|cinema|cin[eé]ma/i,
    title: "FILM",
    text: `Only high-confidence structure is given; check the subject guide for weights, durations and task details.
SYLLABUS / COURSE MAP
- Students study film as an art form, analyse film language (framing, shot types, movement, editing, sound, mise-en-scene), study films from different cultures and periods, and make films. Areas include film theory and history, textual analysis, and film production roles.
ASSESSMENT
- Tasks include textual analysis of a film extract, a comparative study of films, a film portfolio, and a collaborative film project in which the student takes defined production roles. Check the guide for durations, weights and word limits.
HOW MARKS ARE EARNED
- Reward analysis of how specific film techniques create meaning, comparison that builds an argument, understanding of context, and, in practical work, deliberate technical and creative choices with reflection.
COMMON ERRORS AND MISCONCEPTIONS
- Summarises the plot. Ask: "Which shot or sound choice shows this idea, and why?"
- Names a technique without effect. Ask: "What does that cut do to the viewer's attention?"
- Ignores sound. Ask: "What would change if the music was removed?"
- Compares by listing. Ask: "What do the two films say differently about the same idea?"
- Confuses genre with style. Ask: "What conventions does it follow and which does it break?"
TUTOR MOVES
- Ask them to watch and describe before they interpret; ask what the director chose to leave out. Never write analyses; check the guide for details.`,
  },
  {
    test: /^(?!.*(\bb\b|ab ?initio|acquisition|langue b|language b))(?=.*(fran[cç]ais|french|litt[eé]rature fran)).*/i,
    title: "FRENCH A (LITTERATURE / LANGUE ET LITTERATURE)",
    text: `Work in French when the student does; this is a French first-language course (Langue A). Two courses exist: Littérature (literary works only) and Langue et littérature (literary and non-literary texts). Keep them distinct. Do NOT write essays, commentaries or orals for the student; ask questions about their thesis, quotations and technique.
SYLLABUS / COURSE MAP
- Three areas of exploration: Lecteurs, auteurs et textes; Temps et espace; Intertextualité (liens entre les textes). Seven concepts: identité, culture, créativité, communication, perspective, transformation, représentation. Five questions mondiales (fields of inquiry): culture, identité, communauté; croyance, valeurs, éducation; politique, pouvoir, justice; art, créativité, imagination; science, technologie, environnement.
- School programme, FRENCH A LITTERATURE (2026-2028): the portfolio is kept (not marked). Per the outline the work counts are: SL 7 works (3 literary forms, 3 periods, 3 countries on at least 2 continents; 3 in French, 2 translated, 2 freely chosen); HL 9 works (4 forms; 4 in French, 3 translated, 3 free). Units: (1) Écriture palimpseste: de la mémoire individuelle à la mémoire collective (Annie Ernaux, Les Années; Nancy Huston, Lignes de faille; Nina Bouraoui, Garçon manqué); (2) Les tragédies de l'Histoire: dire l'indicible (Marguerite Duras, Hiroshima mon amour; Primo Levi, Si c'est un homme; Wajdi Mouawad, Incendies); (3) Dire l'exil: une esthétique du tragique (Aimé Césaire, Cahier d'un retour au pays natal and Discours sur le colonialisme; Mahmoud Darwich, La terre nous est étroite); (4) Révoltes et conditions féminines (Toni Morrison, Beloved (HL only); Madame de Staël, De la littérature); (5) écriture de l'introspection (Thoreau, De la marche). Check which texts are in the student's own list.
- FRENCH A LANGUE ET LITTERATURE SL (school outline 2026-2028): Marguerite Duras, L'Amant; Charles Perrault, Contes; Henrik Ibsen, Une maison de poupée; Aristophane, Lysistrata, with non-literary documents (posters, press, podcasts, photographs, a graphic novel, films) linked to each. The guiding problem is how language and literature reveal, challenge and reinvent the norms that shape identity.
ASSESSMENT
- External 70% at SL and 80% at HL; internal oral 30% at SL and 20% at HL (school outline); inside that, SL is Paper 1 35% + Paper 2 35%, HL is Paper 1 35% + Paper 2 25% + HL essay 20%.
- Epreuve 1 (Paper 1). Littérature: analyse littéraire dirigée: SL 1 h 15, a choice of two extracts of different forms, each with a guiding question on a formal aspect; HL 2 h 15, two compulsory extracts. Langue et littérature: commentary on one non-literary text (SL, 1 h 15) or both (HL, 2 h 15).
- Epreuve 2 (Paper 2): composition comparative, 1 h 45, same at SL and HL: four general questions, the student picks one and answers with a comparative essay on two works studied.
- Composition du niveau supérieur (HL essay, 1,200 to 1,500 words): a question mondiale of the student's own on one studied work; submitted in the second year (the school sets the date, around the Toussaint holiday).
- Oral individuel (IA): 15 minutes in all: 10 minutes of presentation then 5 minutes of teacher questions (on the extracts first, then on the works). The student chooses two extracts (Littérature: one in French and one translated; Langue et littérature: one literary and one non-literary) and examines a self-chosen question mondiale through BOTH their content and form, without needing to compare them.
- Criteria are the same in outline across papers: knowledge, understanding and interpretation (fond), analysis and evaluation (the literary techniques), focus and organisation (organisation de la démonstration), language (qualité de la langue). The mark counts per criterion: check the subject guide.
HOW MARKS ARE EARNED
- Top: a precise problematique, a plan that builds an argument (not a sequence of devices), short exact citations integrated into sentences, analysis of effect on the reader (what the choice does and why), and for Paper 2 an argument that uses the two works against each other. Language: accurate, varied, formal register.
- Middle: correct but descriptive; lists devices (« le champ lexical de... ») without effect; paraphrase; the second work is added as an afterthought.
- Vocabulaire d'analyse: procédé, registre, tonalité, focalisation, point de vue, ellipse, analepse, prolepse, hypotypose, métaphore filée, antithèse, rythme, ironie, double énonciation, inter-textualité.
COMMON ERRORS AND MISCONCEPTIONS
- Raconte l'histoire au lieu d'analyser. Ask: "Quel est le choix de l'auteur dans cette phrase, et que produit-il chez le lecteur ?"
- Relève les procédés sans effet (« il y a une métaphore »). Ask: "Et alors ? Qu'est-ce que cette métaphore fait comprendre que le mot propre ne dirait pas ?"
- Plan en suite d'outils (champ lexical, puis ponctuation...). Ask: "Quelle idée relie vos trois parties ?"
- Problématique absente ou formulée comme un thème. Ask: "Votre question admet-elle une réponse discutable ? Quelle est votre réponse ?"
- Citations trop longues ou non intégrées. Ask: "Quels mots exacts portent l'effet ? Pouvez-vous ne citer que ceux-là ?"
- Epreuve 2 : deux monographies côte à côte. Ask: "En quoi la comparaison change-t-elle votre lecture de chaque œuvre ?"
- Question mondiale trop vague (« la femme »). Ask: "Quelle question précise sur le pouvoir ou l'identité ces deux extraits permettent-ils de poser ?"
- Oral : récite un texte appris, ne regarde pas les extraits. Ask: "Quelle phrase de l'extrait appuie ce que vous venez de dire ?"
- Oral : ne traite que le contenu ou que la forme. Ask: "Comment la forme de l'extrait construit-elle le sens ?"
- Ne cite pas le contexte (Époque, genre). Ask: "Qu'est-ce que l'époque change à la lecture de ce passage ?"
- Jugement de valeur (« c'est beau »). Ask: "Qu'est-ce qui, dans le texte, produit cet effet ?"
- Traduction sans regard critique (œuvre traduite). Ask: "Que perd-on ou gagne-t-on en lisant la traduction ? Sur quels mots ?"
- Langue Lit : analyse un document non littéraire comme un poème. Ask: "Quel est le but, le public, le contexte de ce document ?"
- Erreurs de langue récurrentes (accords, concordance des temps). Ask: "Relisez cette phrase : quel mot ne s'accorde pas avec quel autre ?"
QUESTION TYPES AND TECHNIQUE
- Epreuve 1 method: lire deux fois ; annoter (repérer, structurer, interpréter) ; trouver le mouvement du texte ; formuler une problématique liée à la question guide ; plan en 2 ou 3 axes ; introduction courte ; analyse de passage en passage ; conclusion qui répond. Guide annotation by questioning: what changes between the lines? who speaks? what is repeated? what surprises?
- Epreuve 2: choisir la question (the question mondiale), sélectionner deux œuvres, thèse commune, 3 parties comparatives, des exemples précis des deux œuvres dans chaque partie.
- Oral: 10 minutes: 30 seconds d'introduction (question mondiale), puis extrait 1 (3 min), extrait 2 (3 min), synthèse (2 min), then 5 minutes of answers. Practise with a timer and notes of keywords only.
CALIBRATION EXAMPLES
- Paper 1 question: « Comment l'auteur fait-il sentir l'indicible dans cet extrait ? » Top-band: names the tension (dire / ne pas dire), cites 3 or 4 short phrases, links syntax (ellipses, phrases courtes) to silence, and concludes on the effect on the reader.
- Paper 2: « Dans quelle mesure la littérature donne-t-elle une voix à ceux qu'on n'entend pas ? » Top-band: a thesis, two works (for example Levi and Mouawad), three comparative parts (temoignage, fiction, réception), nuance.
- Oral question mondiale example: « Comment l'art transforme-t-il la mémoire collective en identité ? »
TUTOR MOVES
- Ask the student to say the idea of the passage in one sentence before any plan. Use "Pourquoi ce mot ici ?" repeatedly. Mark language errors by pointing at the line and asking for the rule, not by rewriting.
- Oral coaching: timing, a clear opening, extracts quoted precisely, direct answers to the teacher; rehearse questions aloud.
- If the student's list of works differs from the above, follow their list; do not assume.`,
  },
  {
    test: /ab ?initio|\b(language|langue|lang)\.? ?b\b|language acquisition|\b(english|french|fran[cç]ais|spanish|chinese|mandarin|german|italian|arabic|japanese|portuguese|russian|hindi|korean|dutch|swedish)\b.{0,12}\bb\b|spanish|chinese|mandarin|german|italian|arabic|japanese|portuguese|russian|hindi|korean|french|fran[cç]ais/i,
    title: "LANGUAGE ACQUISITION (LANGUAGE B AND AB INITIO)",
    text: `Language B (SL and HL, for students with prior knowledge) and ab initio (SL only, beginners) are language ACQUISITION courses: the goal is to communicate well in the target language, not to analyse literature (except literature at HL). Respond in the target language when the student can follow it; use English to explain a rule.
SYLLABUS / COURSE MAP
- Five prescribed themes: IDENTITIES (language and identity, beliefs and values, lifestyles and subcultures, health and well-being), EXPERIENCES (leisure, holidays and travel, life stories, customs and traditions, migrations, rites of passage), HUMAN INGENUITY (communication and media, artistic expressions, scientific innovation), SOCIAL ORGANISATION (social relationships, the working world, education, law and order, social engagement), SHARING THE PLANET (environment, human rights, equality, globalisation, global conflicts, inequalities).
- Skills: receptive (listening, reading), productive (writing, speaking), interactive (conversation). Concepts: audience, context, purpose, meaning, variation.
- FRENCH B at this school (outline 2026-2028): units follow the five themes (Identités, Expériences, Partage de la planète, Organisation sociale, Ingéniosité humaine); sources include documentaries, press, podcasts, ads, interviews, films and short extracts. HL studies two francophone literary works (examples in the list: Camus L'Hote; Naomi Fontaine, Shuni and Kuessipan; Lilian Thuram; Zeina Abirached). Levels run from A2/B1 to C1.
- CHINESE B (outline 2026-2028): simplified characters; SL baseline about HSK 3 (aiming at HSK 4 to 5), HL baseline about HSK 4 (aiming at HSK 5 to 6); the text types taught include diary, personal statement, blog, email, travel guide, speech, news report, interview, opinion column. HL literary works include Lin Haiyin, Chengnan jiushi (City South Stories), and Yu Hua, Huozhe. Writing is counted in characters.
- Other B languages (English B, Spanish B, etc.): same themes and exam structure; check the subject guide for HL literature.
- AB INITIO: SL only, a beginner course based on the five themes with a more limited vocabulary; the exam, durations and word limits differ (check the subject guide for word counts and durations).
ASSESSMENT (Language B; confirmed by the school's outlines)
- Paper 1, Productive skills, writing, 25%: SL 1 h 15, one task of 250 to 400 words (Chinese: 250 to 400 characters) chosen from three, each a different theme and requiring a text type from a list; HL 1 h 30, 450 to 600 words (Chinese: 400 to 600 characters). Marked out of 30: Criterion A Language, B Message, C Conceptual understanding (format and register for the text type; confident mark split A 12, B 12, C 6).
- Paper 2, Receptive skills, 50%: SL 1 h 45 total (listening 45 min, 25 marks; reading 1 h, 40 marks); HL 2 h total (listening 1 h; reading 1 h). Three audio texts and three written texts across themes.
- Individual oral (internal, 25%, 30 marks): SL 12 to 15 minutes with 15 minutes of preparation: a presentation about a visual stimulus linked to a theme (3 to 4 minutes), follow-up discussion (4 to 5 minutes) and general discussion of another theme (5 to 6 minutes). HL: 20 minutes of preparation, an extract from one of the two literary works studied, a presentation of 3 to 4 minutes, then discussion of the extract (4 to 5) and a general discussion on a theme (5 to 6). Criteria: A Language, B Message, C Interactive skills (communication).
- Ab initio: the structure is Paper 1 writing, Paper 2 listening and reading, and an individual oral; check the subject guide for the durations and weights.
HOW MARKS ARE EARNED
- Writing: a task answered fully, a recognisable TEXT TYPE with its conventions (e.g. blog: informal, personal title, direct address, paragraphs; speech: opening and closing address, rhetorical devices; formal letter: salutation, register, closing), REGISTER consistent with the audience, ideas developed (reasons, examples), organisation with a range of connectors, accurate and varied language. The top band needs complexity (subordination, tenses, vocabulary range) with few errors; the middle band is clear but simple and repetitive.
- Listening and reading: accuracy and understanding of detail, inference, and the exact words asked for; short answers (not whole sentences) unless asked.
- Oral: quality of language, develop ideas with examples, answer the teacher's questions directly, extend answers, show cultural awareness and interact naturally.
COMMON ERRORS AND MISCONCEPTIONS
- Uses connectors but no clear task type/register. Ask: "Who is reading this, and what would they expect it to look like?"
- Writes about the theme, not the task. Ask: "What exactly did the prompt ask you to do (persuade, explain, describe)?"
- Mixes tu/vous or tu/usted, informal and formal. Ask: "Who are you writing to? Is that word right for them?"
- Translates word for word from English. Ask: "How would a native speaker say this idea?"
- Wrong tense or agreement (gender, accord du participe passé, ser/estar). Ask: "Which word does this verb agree with?"
- Repeats simple words (très, bien, cosa, good). Ask: "What is a more precise word for this?"
- Very short answers in listening/reading. Ask: "Which exact words in the text answer the question?"
- Misses the number of marks. Ask: "How many marks is this, so how many pieces of information are needed?"
- Memorised paragraph not related to the prompt (oral and writing). Ask: "How does this sentence answer this question?"
- Oral: stops after one sentence. Ask: "Can you give a reason and an example?"
- Oral: describes the image only. Ask: "How does the image link to the theme and your own experience?"
- Writing exceeds or falls short of the word limit. Ask: "How many words do you have, and does the limit matter on this task?"
- No cultural reference. Ask: "Can you connect this to a place or example from the target culture?"
- HL: summarises the literary extract. Ask: "What does the extract show about the character or theme in the whole work?"
- Chinese B: wrong or missing measure words, particles, tones in pinyin, or wrong 'de/di/de' use. Ask: "Which measure word goes with this noun?"
QUESTION TYPES AND TECHNIQUE
- Writing: read the three prompts, choose the one where you have most to say, name the text type, audience and purpose, plan 3 or 4 paragraphs with a connector for each, write, then check verbs, agreement and register. Leave 5 minutes for checking.
- Sentence-level feedback by questioning: point to the line and ask them to identify the rule; ask them to fix it; never rewrite.
- Oral: a clear three-part structure, with a prepared opening for the image, ideas with reasons and examples, and phrases for gaining time and clarifying.
CALIBRATION EXAMPLES (sample prompts; do not write answers)
- French B P1: « Vous avez participé à un échange scolaire. Écrivez un article pour le journal du lycée pour convaincre d'autres élèves d'y participer. » Top-band: title, an intro, 3 reasons with examples, a call to action, register adapted to teenagers, complex sentences.
- French B oral stimulus: a photo of a street protest. Top-band: describe, link to the theme, give an opinion with a reason, handle the teacher's question about the other theme.
- Spanish B P1: « Escribe un blog sobre cómo las redes sociales cambian la forma de relacionarse con los demás. » Top: informal voice, first-person examples, a mix of subjunctive and indicative, connectors (sin embargo, por lo tanto).
- English B P1: "Write a speech for your school assembly urging students to reduce waste." Top: address, hook, 3 developed points, rhetorical question, call to action.
- Chinese B P1 (confident only for the shape): write a diary or personal statement about the student's identity; a top response keeps the text type's conventions and uses connectors and measure words correctly.
TUTOR MOVES
- Ask them to name the text type, audience and purpose first. Give feedback as questions at the sentence level (« quel est le sujet de ce verbe ? »). Practise the oral aloud with a timer and model follow-up questions. Never write the task for them; offer the structure and ask for their ideas.`,
  },
  {
    test: /english|literature|\blit\b|lang(uage)? ?(and|&|\/)? ?lit|langue et litt/i,
    title: "ENGLISH A (LANGUAGE AND LITERATURE / LITERATURE)",
    text: `Two courses exist and they differ: LANGUAGE AND LITERATURE (literary works AND non-literary texts, with a focus on how language works in context) and LITERATURE (literary works only). Ask which one the student takes and at what level. You teach reading and arguing; you never write an essay, commentary or oral for them.
SYLLABUS / COURSE MAP
- Three areas of exploration: Readers, writers and texts (close language analysis, how meaning is made); Time and space (context: how the text is shaped by when and where it was made and read); Intertextuality: connecting texts (comparison and conversations between texts). Seven concepts: identity, culture, creativity, communication, perspective, transformation, representation. Global issues for the oral come from five fields of inquiry: culture, identity and community; beliefs, values and education; politics, power and justice; art, creativity and the imagination; science, technology and the environment.
- School programme, LANGUAGE AND LITERATURE SL/HL (2026-2028): literary works Manuel Puig, Kiss of the Spider Woman; Euripides, Medea; Martin Espada, a collection of poems (Prisoners of Saint Lawrence, The Poet in the Box, The Moon Shatters on Alabama Avenue, The Meaning of the Shovel, There but Not There, El Morivivi, How We Could Have Lived and Died This Way); Kazuo Ishiguro. Non-literary: editorial cartoons, TED talks, Reagan speeches, US Army commercials, the documentary Jesus Camp, the film Apocalypse Now, blogs, diaries, letters, adverts, newspaper articles and legal documents. Extracts from Fitzgerald, Atwood, Lawrence, Plath, Joyce and others are used for mini units. The student keeps a learner portfolio (not marked) that feeds the oral and essays; four mock exam weeks are held. Follow the student's own list if different.
ASSESSMENT
- Language and Literature SL: Paper 1 (35%): analysis of ONE of two non-literary texts, 1 h 15; Paper 2 (35%): comparative essay on two studied works from one of four questions, 1 h 45; Individual Oral (30%): 15 min in total, a 10-minute presentation then 5 minutes of teacher questions. HL: Paper 1 (35%) analyses BOTH texts, 2 h 15; Paper 2 (25%); HL Essay (20%), 1,200 to 1,500 words, a line of inquiry on one studied text or work; Individual Oral (20%).
- Literature: Paper 1 is a guided literary analysis (SL: choose one of two unseen literary passages with a guiding question, 1 h 15; HL: both, 2 h 15); Paper 2 comparative (1 h 45); the oral and HL essay as above. Weights are the same as for Language and Literature.
- The Individual Oral: two extracts, one from a literary work and one from a non-literary body of work (Language and Literature) or from two literary works (Literature, one originally in another language and read in translation, check the guide), and the student discusses how a global issue of their choice is presented through the content AND form of both extracts. Prepared outline notes are allowed (check the guide for how much).
- Marked against four criteria in each component: A Knowledge, understanding and interpretation; B Analysis and evaluation; C Focus and organisation; D Language. Marks per criterion differ by component: check the guide.
HOW MARKS ARE EARNED
- Top bands: a clear, perceptive reading that stays at the level of "how and why" (the writer's choices and effects), a controlled line of argument, precise, short quotations woven into sentences, evaluation of effects and context, and language that is accurate and academic without padding.
- Middle: sound understanding but narrative or device-spotting; quotations that are long or unexplained; a conclusion that restates.
- Paper 1 (Language and Literature) rewards audience, purpose, context and genre conventions, then language and visual features (layout, image, tone) and their effect. Paper 1 (Literature) rewards literary features: structure, voice, imagery, tone, sound and form.
- Paper 2 rewards a thesis that answers the question, balanced treatment of both works, knowledge of texts, and comparison that builds the argument (not two mini-essays).
- Command words: analyse (how choices create meaning), compare and contrast (similarities and differences), discuss (considered, balanced view), evaluate (judge how effective), to what extent (a verdict), examine.
COMMON ERRORS AND MISCONCEPTIONS
- Summarises the plot instead of analysing technique. Ask: "What choice did the writer make in this line, and what does it make the reader feel or think?"
- Feature-spotting ("metaphor, alliteration") with no effect. Ask: "So what does that metaphor do that a plain statement would not?"
- Quotation too long or dropped in. Ask: "Which three words carry the effect?"
- No thesis; description followed by a summary. Ask: "What is your answer to the question in one sentence?"
- Paper 2 treats works separately. Ask: "What does the comparison show about each work that you could not see alone?"
- Ignores the question's key terms. Ask: "Which word in the question have you not used yet?"
- Language and Literature: ignores the text type (audience, purpose, context). Ask: "Who is this for, why was it made, and how does the form show that?"
- Literature: treats the narrator or speaker as the author. Ask: "Who is speaking here, and how do you know?"
- Over-claiming authorial intention ("the author wants to show"). Ask: "What is the evidence in the text for that effect?"
- Context pasted in as a history paragraph. Ask: "How does that context change how we read this scene?"
- Oral: the global issue is vague. Ask: "What is the specific question about the issue that both extracts help answer?"
- Oral: treats content and form separately or only one extract. Ask: "How does the form of this extract create the meaning, and how does the other extract do it differently?"
- Oral: reads a script, no ownership. Ask: "Can you say that point in your own words with the extract in front of you?"
- Language errors (comma splices, tense shifts). Ask: "Which verb tense are you using for literature, and is it consistent?"
- Over-reliance on pre-learned essays. Ask: "How does the prompt change what you can use from your plan?"
QUESTION TYPES AND TECHNIQUE
- Paper 1 annotation method: read once for gist, once pencil in hand. Mark: (1) who speaks to whom, why (audience and purpose); (2) the shape or turns of the text (structure); (3) the repeated or striking words, images and sounds; (4) shifts in tone; (5) the last line. Ask what each mark does. Then a thesis, paragraphs by idea, not by device ("PEEL" adapted: point, evidence, effect, link).
- Paper 2 method: unpack the question, choose works that give a rich contrast, a thesis, three comparative paragraphs each with evidence from both works, brief conclusion that answers. About 5 minutes of planning.
- Oral method (10 min): 30 s opening naming the global issue; extract 1 (about 3 min): what it shows about the issue, with exact quotations; extract 2 (about 3 min); comparison and synthesis (about 2 min); leave time for the teacher's questions (5 min). Rehearse with a timer.
- HL essay: a specific line of inquiry on a work; planning and structure, short quotations, an argument, within word limits; the student writes and you only question.
- Quotation: select the shortest phrase that carries the effect; introduce it; analyse words in it; link to the argument.
CALIBRATION EXAMPLES
- Lang and Lit Paper 1 prompt: a charity advertisement. Top-band: names the audience and purpose, analyses the image-text relationship and tone, links emotional appeal to word choice, evaluates how it constructs a view of the beneficiaries, and ends on the effect.
- Literature Paper 1 guiding question: "How does the poet use form to convey loss?" Top: links line breaks, enjambment, and imagery to the idea.
- Paper 2: "To what extent do writers use setting to reveal power?" Top: thesis, two works (for example Medea and Kiss of the Spider Woman), three comparative points, judgement.
- Oral global issue: "How are ideas about identity and exile presented through the content and form of a poem by Espada and a speech?"
TUTOR MOVES
- Annotation coaching: ask what they notice, then what it does. Never produce the paragraph. If they get stuck, ask "what is the odd one out in this passage?"
- Essays: ask for their thesis in one sentence, then ask them to find the quotation that most supports it, then the strongest objection.
- Sentence level: point to the weak sentence and ask what it claims and what evidence supports it.
- Oral: run it with a timer, then ask questions as the teacher would, short and probing.`,
  },
];

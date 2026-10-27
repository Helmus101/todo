// IB Group 3 (individuals and societies) and ESS knowledge packs. Plain text for the tutor prompt; see ibSubjects.ts for the format.
export const GROUP3_PACKS: { test: RegExp; title: string; text: string }[] = [
  { test: /\bess\b|environmental systems/i, title: "ENVIRONMENTAL SYSTEMS AND SOCIETIES (IB ESS)", text: `IB ESS: DEEP KNOWLEDGE FOR THE TUTOR. ESS is interdisciplinary (sciences plus individuals and societies) and counts in group 3, group 4 or both. Ask SL or HL. The school follows the revised ESS course (2026-2028 cohort) built from guiding questions, with HL "lenses". Topic numbering below follows the school's outline; check the guide for any renumbering.

1. SYLLABUS MAP
- Topic 1 Foundations: 1.1 perspectives (environmental value systems: ecocentric, anthropocentric, technocentric, and what shapes them; how values affect decisions); 1.2 systems and models (systems approach, inputs, outputs, storages, flows, open/closed/isolated systems, equilibrium, feedback loops, models and their limits); 1.3 sustainability (sustainable development, natural capital and income, planetary boundaries, tipping points, resilience, environmental justice, the SDGs, circular and doughnut economy).
- Topic 2 Ecology: 2.1 individuals, populations, communities and ecosystems (niche, interactions, population growth curves, limiting factors, carrying capacity, r- and K-strategies); 2.2 energy and biomass (food chains, webs, pyramids, trophic efficiency, productivity GPP and NPP, sustainable yield, available versus unavailable energy); 2.3 biogeochemical cycles (carbon cycle and human effects; HL goes further into geological eras and the nitrogen cycle); 2.4 climate and biomes (climate determines biome; HL adds El Nino/La Nina and severe weather); 2.5 zonation, succession and change (primary and secondary succession, climax community, resilience, recovery after disturbance).
- Topic 3 Biodiversity and conservation: measuring diversity (species richness, evenness, Simpson's index), causes of loss (habitat loss, invasive species, overexploitation, pollution, climate change), tragedy of the commons, conservation strategies (protected areas versus species-based, rewilding, community and Indigenous-led conservation, NGOs), and the argument for preserving biodiversity.
- Topic 4 Water and aquatic food production: water systems and the water cycle, access and security, equity and conflict over shared water, pollution (eutrophication, dead zones, BOD, indicator species), aquatic food production and sustainability of fisheries and aquaculture.
- Topic 5 Land and soil, terrestrial food: soil systems and degradation (erosion, salinisation, desertification), conservation; agricultural systems, the Green Revolution, fertiliser use, sustainability of different farming and diets (HL deeper on permaculture and traditional systems).
- Topic 6 Atmosphere and climate change: atmosphere structure, tricellular model, greenhouse gases and aerosols, anthropogenic causes and evidence, mitigation and adaptation, stratospheric ozone and the Montreal Protocol (HL adds climate models, equity, IPCC and specific substances).
- Topic 7 Natural resources / climate change and energy: renewability of natural capital, energy sources (fossil fuels, nuclear, wind, hydro), energy security, efficiency, conservation, feedbacks such as albedo, mitigation and adaptation timescales.
- Topic 8 Human populations and urban systems (the school's outline also lists resource use and waste): population dynamics (pyramids, demographic transition, policies), natural goods and services, solid domestic waste and waste hierarchy, carrying capacity, ecological footprint.
- HL ONLY lenses: A Environmental law (local to international law, effectiveness, legal personhood and biorights for nature); B Environmental economics; C Environmental ethics (moral responsibility, biorights, ethical frameworks). The school's outline emphasises A and C.

2. ASSESSMENT (the school's outline; check the guide for mark totals)
- Paper 1 (SL 25%, HL 30%; SL about 1 hour, HL about 2 hours): analysis and evaluation of data in a previously unseen case study.
- Paper 2 (50% for both; SL about 2 hours, HL about 2.5 hours): short-answer and data-based questions, plus two structured essays chosen from four topics.
- Internal assessment (SL 25%, HL 20%): a written report on an ESS research question of the student's choice, designed and carried out by them (about 10 class hours, possibly on the field course). The criteria are likely research design, data analysis, conclusion, evaluation and communication; check the guide for exact criteria and marks. The tutor questions the question, variables, controls, sampling and the validity of the conclusion, never the numbers or text.
- Also: practical work (about 20 hours) and a group 4 ecology field project in Barcelona (Simpson's index, BOD, Pearson's correlation, standard deviation, quadrats).

3. HOW MARKS ARE EARNED
- Paper 1 rewards reading the data first: patterns, trends, comparisons with figures, calculations, the reliability of the data and method, and an evaluation of management proposals using the case study evidence.
- Paper 2 structured essays use markbands rewarding knowledge and understanding (correct ESS terminology), application to a named case study or example, analysis, and evaluation that integrates different perspectives. Top answers use specific examples with facts, show feedback loops or flows correctly, compare environmental value systems, and conclude with a balanced judgement.
- Command terms: Define, State, Outline (brief), Describe (details and trend), Explain (cause and mechanism), Compare (similarities and differences), Distinguish, Discuss (balanced, several perspectives, conclusion), Evaluate (strengths and limitations, then a judgement), To what extent (a verdict with degree), Justify, Suggest, Calculate, Analyse (relationships in the data).
- Perspectives are rewarded: attribute views to value systems or stakeholders (Indigenous communities, industry, governments, NGOs) and separate facts from values.

4. COMMON ERRORS AND MISCONCEPTIONS (each with a diagnostic question)
- Treats a model as the real system. Q: Name two things your model leaves out and one prediction it could get wrong because of that.
- Confuses a positive and a negative feedback loop (positive means good). Q: Does the change get amplified or reduced by the loop?
- Draws a "cycle" diagram with arrows but no stores, flows or units. Q: Which are the stores and which the flows?
- Says energy is recycled in an ecosystem. Q: What leaves each trophic level, and in what form?
- Gets the 10% rule wrong or applies it to biomass without checking. Q: Where does the other 90% go?
- Mixes GPP, NPP and respiration. Q: Which of these is available to the herbivore?
- Treats the greenhouse effect as the problem rather than the enhanced effect. Q: What is the natural effect doing for the temperature of the Earth?
- Confuses the ozone hole with global warming. Q: Which gases cause each and which regulation addresses each?
- Mixes up weather and climate. Q: Over what time period do you average to call something climate?
- Confuses mitigation and adaptation. Q: Does your action reduce the cause or the harm?
- Says "sustainable" without saying what is being sustained, for whom, over what time. Q: What is the resource, who uses it, and how long?
- Equates renewable with sustainable. Q: Can a renewable resource be used unsustainably?
- Lists environmental value systems without applying. Q: Which value system would support this policy and which oppose it?
- Describes a case study without detail (a country but no figures). Q: What year, how much, what happened next?
- Mistakes species richness for diversity. Q: Two communities each have 4 species: one with equal numbers, one with 97 percent of one species; which is more diverse?
- Says biodiversity loss means species extinction only. Q: What other levels of diversity may fall (genetic, habitat)?
- Claims the tragedy of the commons proves that common resources always fail. Q: What conditions (open access, no rules) does the idea require, and what counter-examples of managed commons exist?
- In practicals, confuses independent and dependent variables, or lacks controls, repeats, or sampling method. Q: Which single variable changed and how did you keep the others constant?
- Evaluation only says "human error". Q: Which specific error affects your conclusion, and in what direction?
- States a correlation as cause or cites a statistical test without interpreting it. Q: What does the test value say about the chance the relationship is random?
- Ignores equity and justice in resource questions. Q: Who bears the cost and who gets the benefit?

5. QUESTION TYPES AND EXAM TECHNIQUE
- Paper 1: read the case study background first, label graphs, quote values, calculate (percent change, rates, Simpson's index, productivity), explain the pattern with the ESS idea behind it, then evaluate a proposal against criteria (effectiveness, cost, time, justice, evidence quality).
- Paper 2 short answers: one clear point per mark, with correct vocabulary; for diagrams, label stores and flows; calculations with working and units.
- Essays: choose the two where you have a concrete case study; plan 5 minutes: define, explain with system terms, case study, other perspective, evaluation. About 20 to 25 minutes each.
- Case studies: have a named example for each of the topics (an invasive species, a protected area, a fishery, a farming system, a pollution event, a climate policy, an energy source); stay with real facts only if sure.

6. CALIBRATION EXAMPLES (original; data fictional)
- Q1 [Paper 2, 3 marks]. A fictional quadrat survey of a meadow found 10 clovers, 5 daisies, 3 buttercups and 2 plantains. Calculate Simpson's index D = N(N-1) / sum of n(n-1) and interpret. Answer: N = 20; N(N-1) = 380; sum n(n-1) = 90 + 20 + 6 + 2 = 118; D = 380/118 = 3.22 (3.2). For comparison, the same 20 plants split evenly (5 each) would give 380/80 = 4.75, so 3.2 shows dominance by clover (lower evenness); D is only meaningful when compared with another site or time, and a higher D means more diverse.
- Q2 [Paper 2, 3 marks]. A fictional grassland has GPP 5,000 and plant respiration 3,200 kJ per square metre per year. Calculate NPP and say what it represents. Answer: NPP = GPP - R = 1,800 kJ per m2 per year; this is the energy stored in new biomass available to consumers and decomposers.
- Q3 [Paper 2, 3 marks]. A fictional country has crude birth rate 18 and death rate 8 per 1,000, with no migration. Calculate natural increase rate and doubling time (rule of 70). Answer: (18 - 8)/10 = 1.0 percent; doubling time about 70/1.0 = 70 years.
- Q4 [Paper 2 essay, about 15 marks]. Evaluate the extent to which conservation strategies protect biodiversity. Outline: define biodiversity and the threats; compare species-based and habitat-based conservation, protected areas, rewilding, community-led management; named case; success criteria (population trends, costs, people displaced); perspectives (ecocentric versus anthropocentric); HL: role of law (enforcement, treaties) and ethics (biorights); judgement of conditions for success.

7. TUTOR MOVES
- Ask the student to draw the system before explaining: inputs, outputs, stores, flows, feedback. Then ask what the model hides.
- Always ask "which environmental value system and who is affected?" after a technical answer, to build perspective-taking.
- Probe data skills: the unit, the percent change, the sample size and what it means; ask them to design the test before they run it.
- For HL, ask whether the problem is better served by law, economics or ethics and have them argue the other side, then weigh them.
- For the IA and fieldwork: ask what could make the result wrong. Never write their research question or analysis.` },
  { test: /global politics|\bgp\b|world politics/i, title: "GLOBAL POLITICS (IB)", text: `IB GLOBAL POLITICS: DEEP KNOWLEDGE FOR THE TUTOR. No school outline was supplied; this describes the current guide in general terms and marks anything uncertain with check. Ask SL or HL.

1. SYLLABUS MAP
- Four core units (SL and HL), each built on the key concepts of power, sovereignty, legitimacy and interdependence. Unit 1 Power, sovereignty and international relations: state and non-state actors, types of power (hard, soft, smart, economic, structural), the nature of sovereignty (internal, external, challenges to it), the international system (unipolar, bipolar, multipolar), realism, liberalism, constructivism and other theories (check), global governance (UN, regional organisations, IMF, WTO), legitimacy and the role of NGOs and transnational corporations. Unit 2 Human rights: the UDHR, treaties, universality versus cultural relativism, the Responsibility to Protect, enforcement and the International Criminal Court, civil/political versus economic/social rights, non-state actors. Unit 3 Development: measures of development (GDP, HDI, Gini), theories (modernisation, dependency, neoliberalism), inequality, aid, debt, trade, sustainability, poverty reduction, the Sustainable Development Goals. Unit 4 Peace and conflict: types of conflict (interstate, civil, asymmetric), causes (ethnic/identity, resources, ideology, state failure), the concept of peace (negative and positive), peacekeeping, peacebuilding, peace agreements, transitional justice, terrorism, and the role of third parties.
- HL extension: global political challenges, studied through two or more chosen challenges from a list that includes environment, poverty, health, identity, borders and security (check the exact list and number). Each is studied through concepts, case studies and different perspectives, with attention to the interplay of actors at different scales.
- Case studies: students need real, located examples with dates and facts for each unit; they pick them with their teacher. Do not assume which examples they know; ask.

2. ASSESSMENT (from memory; durations, weights and mark totals: check the guide)
- Paper 1 (SL and HL): stimulus-based questions; students use extracts or visuals on one of the units (a short question set followed by a longer one).
- Paper 2 (SL and HL): extended-response (essay) questions on the units with examples.
- Paper 3 (HL): the global political challenges, with essay-style responses to a stimulus (check).
- Internal assessment: engagement activity (SL and HL): a practical political engagement (for example an interview, attending a meeting, a campaign, research on a local issue), written up as a report of up to about 2,000 words linking it to a global political challenge, reflecting on the evidence; HL adds a further dimension (check). Never write the report; ask about the question, the evidence they collected, and the link between local and global scale.

3. HOW MARKS ARE EARNED
- Paper 1 rewards reading the stimulus (origin, message, perspective and limitations) and using it with the unit's concepts; Paper 2 rewards concept-driven essays: knowledge and understanding of the concepts, application to real examples, analysis, evaluation, and structure.
- Band 1-2: descriptive, opinions, vague examples ("a country", "the UN"). Band 5-6 (top): precise definitions, concept used as the engine of the argument, multiple specific cases with dates and facts, counter-arguments from rival perspectives (for example realist versus liberal), a judgement based on the evidence.
- Command terms: Define, Outline, Describe, Explain, Analyse (show the elements and how they relate), Compare and contrast (both, using the same points), Discuss (balanced views and a conclusion), Evaluate (weigh strengths and limitations, then a judgement), To what extent, Examine, Justify, Distinguish. Use the term as the shape of the answer.
- Examples must be used as evidence: name the event, the year, the actors and what it shows, not just "e.g. Syria".
- Perspectives: the course expects awareness that actors differ in interests and values; present the main viewpoints fairly, then judge.

4. COMMON ERRORS AND MISCONCEPTIONS (each with a diagnostic question)
- Treats the state and the government as the same. Q: What are the permanent features of a state, and which can change when the government does?
- Treats sovereignty as absolute or as lost. Q: In what ways can sovereignty be limited and still exist?
- Confuses power with force. Q: What forms of power succeed without coercion?
- Confuses hard and soft power or treats soft power as purely cultural. Q: Which instrument is coercive, which attractive, and could one policy be both?
- Describes theories without applying (realism, liberalism, constructivism). Q: How would a realist explain this event differently from a liberal?
- Treats legitimacy as legality. Q: Can an action be legal but lack legitimacy?
- Equates human rights with laws that are enforced. Q: What is the difference between a right being recognised and being protected?
- Presents universalism versus cultural relativism as a simple choice. Q: What would a middle position look like and is it coherent?
- Treats the UN as a world government. Q: Who has power in the Security Council and why does that limit action?
- Conflates development with economic growth. Q: Name a measure that rises when income rises but may not show well-being.
- Dependency and modernisation mixed up. Q: Which theory blames external structures and which internal stages?
- Treats aid as simply good or simply bad. Q: Under what conditions does aid reach its goal and under what conditions does it harm?
- Confuses peacekeeping, peacemaking, peacebuilding. Q: Which comes after an agreement and which before?
- Confuses negative and positive peace. Q: Is the absence of war the same as justice?
- Treats a conflict as having one cause (ethnicity). Q: What other conditions (resources, state weakness, outside actors) were present?
- Uses recent events as examples without checking facts or dates. Q: What date, what actors, what source for that claim?
- Opinion instead of analysis. Q: What evidence would convince someone who disagrees?
- Leaves out non-state actors or local scale. Q: Which non-state actor matters most here and how does its power work?
- One-sided essay without counter-argument. Q: What would the best opponent of your thesis say?
- Engagement activity: describes the activity without linking to the global challenge. Q: What does your local evidence tell us about the global issue, and what can't it show?

5. QUESTION TYPES AND EXAM TECHNIQUE
- Stimulus questions: identify the source, message and purpose; extract two or three points; link to concepts and knowledge from the unit; evaluate the stimulus as evidence (who made it, to persuade whom).
- Essays: introduction that defines the main concept and states a thesis; body paragraphs with claim, concept, example with specifics, counter-view; conclusion judging "to what extent". Plan with a table of arguments and examples; about 40 minutes for a large essay (check marks and timing).
- HL challenge answers: explain the challenge, compare perspectives of actors at different scales, use two contrasting cases and evaluate responses.
- Evidence banks: for each unit, 2 or 3 cases with dates, actors, outcomes, and which concepts they illustrate.

6. CALIBRATION EXAMPLES (original; the scenarios are fictional)
- Q1 [Essay]. "Sovereignty is no longer the central feature of the international system." To what extent do you agree? Outline: define sovereignty, show how globalisation, institutions and non-state actors challenge it; counter-evidence that states still make decisions and use veto power; realism versus liberalism; two cases (one where sovereignty was limited and one where it was defended); a judgement that distinguishes legal and practical sovereignty.
- Q2 [Essay]. Evaluate the effectiveness of international organisations in promoting human rights. Outline: the mechanisms (treaties, courts, sanctions, monitoring, naming and shaming); case where it worked and where it failed; the role of state consent; universalism; the role of NGOs; judgement conditional on enforcement and great-power interest.
- Q3 [Stimulus, fictional]. A fictional government press statement from the state of Arvia says its army entered a neighbouring province "to protect citizens" and calls outside criticism "interference". Using the statement and your knowledge, analyse the tension between sovereignty and the responsibility to protect. Outline: source origin and purpose (state-issued, justifying), claim of protection, the sovereignty argument; the R2P principle (states have responsibility to protect their populations; international community may act when they manifestly fail; Security Council authorisation), the problem of selectivity and legitimacy; judgement on legitimacy.

7. TUTOR MOVES
- Ask first for the concept, then the case: "Which concept explains this and which actual case shows it?"
- Probe prerequisites: the definitions of state, nation, sovereignty, power and legitimacy; ask them to give a one-line definition and a counter-example.
- Always ask for the opposite view: "How would a realist, a liberal, and an actor from a different region see this?"
- Push toward evaluation with "how do we know, what would change the judgement, in whose view?"
- For HL challenges, ask them to connect the local and global scale and to compare two challenges. Never produce the engagement activity for them.` },
  { test: /digital soc/i, title: "DIGITAL SOCIETY (IB)", text: `IB DIGITAL SOCIETY: DEEP KNOWLEDGE FOR THE TUTOR. No school outline was supplied; this describes the guide in general terms (first assessment 2024) and marks anything uncertain with check. Ask SL or HL.

1. SYLLABUS MAP
- Six concepts frame every topic: change, expression, identity, power, systems, values and ethics. Students analyse digital systems through these lenses and by asking who benefits, who is harmed, who has power and what values are embedded.
- Seven contexts in which digital systems are studied: cultural, economic, environmental, health, human knowledge, political, social.
- Content (SL and HL): data (collection, storage, processing, big data, privacy, ownership, data analysis and visualisation), algorithms (how they work at a conceptual level, bias, transparency, recommendation systems, automated decisions), computers (hardware, software, operating systems, open source versus proprietary, digital divide), networks and the internet (infrastructure, protocols, the web, cybersecurity, net neutrality, censorship, cloud), media (social media, content creation, misinformation, echo chambers, digital activism, online identity), artificial intelligence (machine learning at a conceptual level, generative AI, applications and risks), robots and autonomous technologies (sensors, automation, drones, self-driving vehicles, labour impacts). Check the exact list of topics in the guide.
- HL extension: three studies in which students explore the impact of digital technologies on global well-being, governance and human rights, and sustainability (check wording), with in-depth case studies of a digital technology in real use.
- Skills: inquiry (asking questions, researching), analysis and evaluation of digital systems and their impacts, use of evidence from multiple sources, and communication.

2. ASSESSMENT (from memory; durations, weights, marks: check the guide)
- External papers: Paper 1 is based on an unseen case study or stimulus with structured questions that draw on concepts and contexts; Paper 2 uses extended response/inquiry questions; HL has an additional paper on the HL extension (check form).
- Internal assessment: an inquiry project in which the student investigates a digital issue of their own choice, drawing on research and primary evidence, and presents findings (check format, word and time limits, and criteria). Likely criteria cover the focus and research question, the quality of research, analysis and evaluation of the digital system and its impacts, and recommendations or conclusion. Do not write it; question the inquiry question, sources, and reasoning.

3. HOW MARKS ARE EARNED
- Answers are marked on: knowledge and understanding of the digital technology and concepts; application to the specific context in the stimulus; analysis of impacts on different stakeholders; evaluation with a justified conclusion; use of evidence.
- Band 1-2: general statements about "technology" ("it is good because it is fast"), no stakeholders, no context. Band 5-6 (top): precise terms; mechanism of the technology explained; several stakeholders with different interests; concept applied (power, values and ethics, systems); evidence from the stimulus and outside; counter-arguments; a judgement and, where asked, a recommendation.
- Command terms: Define, Describe, Outline, Explain, Analyse, Compare, Discuss, Evaluate, To what extent, Justify, Recommend. Many questions ask the student to "evaluate the impact" or "discuss the extent" so a judgement is required.
- Stakeholders: users, creators, companies, governments, communities, people excluded; always name which and how they differ.

4. COMMON ERRORS AND MISCONCEPTIONS (each with a diagnostic question)
- Describes the technology without explaining how it works. Q: What does the system take in and what does it give out?
- Treats algorithms as neutral. Q: Who chose the training data or the objective?
- Treats AI as human-like thinking. Q: What does the system actually do when it "understands" a sentence?
- Confuses data and information. Q: What is the raw data and what makes it information?
- Confuses privacy with security. Q: Can a system be secure and still violate privacy?
- Confuses encryption, anonymisation and consent. Q: Which one protects the content and which one the identity?
- Says the internet and the web are the same. Q: What is the network and what runs on it?
- Treats social media impacts as all good or all bad. Q: Who benefits and who is harmed on the same platform?
- Assumes the digital divide is only about devices. Q: What other barriers (skills, language, cost, infrastructure) matter?
- Names only the individual user as stakeholder. Q: Which companies, governments or communities are affected?
- Ignores the context (economic, environmental, etc.). Q: Which of the seven contexts is this question really about?
- Confuses misinformation and disinformation. Q: Did the sharer intend to deceive?
- Treats correlation in big data as proof. Q: What else could explain the pattern?
- Presents ethics as personal opinion. Q: Which value or ethical principle (autonomy, justice, harm) is at stake?
- Environmental impact forgotten (energy, e-waste). Q: What are the environmental costs of running or making this system?
- Power: misses who controls the system. Q: Who decides, who can change, who is excluded?
- Recommendations generic ("educate people"). Q: Who exactly should do what, and what would stop them?
- Uses real-world examples with invented facts. Q: What is the source for that claim?
- Conclusion repeats points. Q: Weighing the impacts, which is greatest and for whom?
- IA: question too broad or purely descriptive. Q: What exactly do you intend to find out, and what evidence would answer it?

5. QUESTION TYPES AND EXAM TECHNIQUE
- Stimulus questions: read the scenario and underline the stakeholders, technology and context before answering; refer to it by name in the answer.
- Longer answers: define the technology briefly; explain how it creates impact through a mechanism; set out impacts for at least two stakeholders; evaluate by weighing them; conclude with a justified judgement or recommendation. Roughly one minute per mark (check marks).
- Use of the concepts: explicitly name the concept (power, values and ethics, systems) and apply it.
- Examples: choose real technologies you know well (a recommendation algorithm, a facial recognition system, a contact-tracing app), and be careful with statistics.

6. CALIBRATION EXAMPLES (original; scenarios fictional)
- Q1 [Short, 4 marks]. A fictional video platform, Streamly, recommends videos using the viewer's watch history. Explain two ways this recommendation algorithm could affect the range of content a viewer sees. Answer: filter bubble/echo chamber because the system reinforces past choices and hides alternatives (1+1); engagement-driven design may promote extreme or sensational content (1+1).
- Q2 [Longer, 10 marks style]. A fictional city introduces facial recognition cameras in public transport to reduce crime. Evaluate the impact on different stakeholders. Outline: how the system works (images matched to a database); benefits (police, commuters feeling safer); harms (privacy, false matches and bias against some groups, chilling effect on assembly, data security); governance (consent, oversight, transparency); concepts: power and values and ethics; weighing and a conclusion with conditions (e.g. strict limits, audits).
- Q3 [Recommend]. A fictional school plans to use an AI marking tool. Recommend whether to adopt it. Outline: benefits (speed, consistency), risks (bias, transparency, error, teacher deskilling, data privacy), stakeholders (students, teachers, parents, the school), conditions (human review, appeals), a justified decision.

7. TUTOR MOVES
- Ask first: "What is the digital system, who uses it, and who else is affected?" then "what does it do with data?".
- Probe prerequisites: data versus information, how a recommendation system works conceptually, privacy versus security.
- Push toward evaluation: "Who gains, who loses, how much, for how long, who decided?" and have the student rank the impacts.
- For HL, ask them to connect a case to well-being, governance or sustainability and to compare two contexts.
- For the IA ask about the question, the source of each claim and the evidence for the conclusion. Never write it.` },
  { test: /business|\bbm\b|\bbman\b|management/i, title: "BUSINESS MANAGEMENT (IB)", text: `IB BUSINESS MANAGEMENT: DEEP KNOWLEDGE FOR THE TUTOR. No school outline was supplied, so this describes the current guide in general terms; anything marked check is something to verify in the subject guide rather than state as fact. Ask SL or HL.

1. SYLLABUS MAP
- Four key concepts run through the course: change, creativity, ethics, sustainability. Five units, each with SL core and HL-only content.
- Unit 1 Introduction to business management: what a business is, types of business entity (sole trader, partnership, company, public sector, non-profit, social enterprise, cooperative), business objectives (mission, vision, aims, strategy, CSR), stakeholders and their conflicts, growth and evolution (internal and external growth, mergers, takeovers, franchising, economies and diseconomies of scale), multinational companies and their impact.
- Unit 2 Human resource management: HR planning, organisational structure (hierarchy, span of control, delegation, flat versus tall), leadership styles and management, motivation theories (Maslow, Herzberg, Taylor, Pink and others, the exact list varies by guide: check), recruitment, training, appraisal, and at HL organisational culture (Handy, Hofstede) and industrial relations (collective bargaining, strikes, lockouts).
- Unit 3 Finance and accounts: sources of finance, costs and revenues (fixed, variable, break-even and margin of safety), final accounts (income statement, statement of financial position, depreciation), profitability and liquidity ratios (gross profit margin, net profit margin, ROCE, current ratio, acid test), efficiency ratios and debt/equity (HL: stock turnover, debtor and creditor days, gearing), cash-flow forecasts, investment appraisal (payback, ARR, NPV at HL), budgets.
- Unit 4 Marketing: marketing planning, market research (primary and secondary, sampling), the marketing mix (7Ps for services), product life cycle, Boston matrix, Ansoff matrix, branding, pricing strategies, promotion, e-commerce, and at HL sales forecasting, international marketing and further analysis of the mix.
- Unit 5 Operations management: production methods (job, batch, flow, mass customisation), lean production, quality (TQM, quality circles, benchmarking), location decisions, supply chain, capacity utilisation, productivity, and at HL R&D, crisis management and contingency planning, production planning (critical path analysis).
- Tools and techniques commonly examined: SWOT, STEEPLE, Ansoff, Boston, Porter's, force-field analysis, Gantt, decision trees (HL), critical path (HL), financial ratios, break-even.

2. ASSESSMENT (structure from memory; durations, weights and mark totals: check the guide)
- External papers: Paper 1 is based on a case study released in advance (students prepare on it); Paper 2 is based on stimulus material with a strong quantitative component; HL has an additional Paper 3 (check form and contents).
- Internal assessment: SL, a written commentary (about 1,500 words) on a real issue facing a business, based on a few supporting documents; HL, a research project (about 2,000 words) on a business issue, using primary and secondary research (check). Criteria reward a clear title and aim, use of concepts and tools, analysis, evaluation and a recommendation or conclusion.
- Practice: use real past papers from the teacher; never rely on an invented case study as a pass or fail predictor.

3. HOW MARKS ARE EARNED
- Short parts: Define/State/Outline are quick marks that reward precise terms. Calculate parts reward formula, substitution and units. Explain parts reward a reason plus a link to the business in the stimulus. Longer parts (10 to 12 marks) use markbands.
- Markband criteria: knowledge and understanding, application to the business context (use its name, product, figures), use of tools and techniques, reasoned analysis, and balanced conclusion/judgement (evaluation). Band 1-2: textbook definition, general statements about "a business". Band 5-6 (top): terms correct, constant reference to the specific business, a quantified or data-based argument, both sides weighed with business-specific considerations (size, sector, stakeholders, short and long run, ethics, risk, cost), and a justified recommendation.
- Command terms: Define, State, Outline, Describe, Explain (reasons applied to the business), Analyse (break down, show how factors interact), Discuss (balanced, with a conclusion), Evaluate (strengths and limitations, then a judgement), Justify (reasons for a recommendation), To what extent (degree), Recommend (a decision with reasons and risks), Compare, Calculate, Construct (e.g. a cash flow forecast).
- Conclusions should be supported: a recommendation must reference the information in the case (cash, culture, competitor, stakeholders), not general preference.

4. COMMON ERRORS AND MISCONCEPTIONS (each with a diagnostic question)
- Uses textbook theory without applying it to the named business. Q: What in the case shows that this theory fits this firm?
- Defines a term but does not use it. Q: What does that definition tell you about this decision?
- Confuses profit and cash flow. Q: Can a profitable firm run out of cash? How?
- Confuses revenue, profit and profit margin. Q: If revenue rises, does profit have to?
- Treats gross profit margin and net profit margin as interchangeable. Q: Which costs are in the numerator of each?
- Calculates ratios correctly but never interprets them. Q: Compared with what, and what does it tell the owner to do?
- Break-even: forgets that contribution per unit is price minus variable cost. Q: How much does each extra sale contribute to covering fixed costs?
- Mixes up margin of safety and break-even. Q: What is the gap between actual sales and break-even output called?
- Payback and NPV mistakes: ignores the time value of money, or sign errors. Q: Why is 1,000 received in year 3 worth less than 1,000 now?
- Says investment appraisal "proves" the best project. Q: What non-financial factors could overturn the numbers?
- Treats Maslow or Herzberg as established fact rather than a model. Q: What evidence supports this theory and where does it fail?
- Confuses leadership with management. Q: What is the difference between setting direction and organising resources?
- Thinks autocratic leadership is always bad. Q: In what context (a crisis, unskilled team) can it be effective?
- Confuses "growth" with "profit". Q: Why might a firm grow but lose money?
- Mixes organic (internal) growth and external growth. Q: Which involves another firm?
- Treats the Ansoff or Boston matrix as a recipe. Q: What data do you need to place each product?
- Lists marketing mix elements without reasoning. Q: Which P matters most for this business, and why?
- Confuses primary and secondary research. Q: Who collected the data and for what original purpose?
- Treats ethics and CSR as free. Q: What does it cost and what does it protect?
- Evaluation is a list of advantages and disadvantages with no recommendation. Q: If you were the CEO, what would you do and what are you accepting?
- Ignores stakeholder conflicts. Q: Which stakeholder loses if this is done and how much power do they have?
- Writes the entire answer as "it depends" without saying on what. Q: On which factor, and what would the answer be in each case?

5. QUESTION TYPES AND EXAM TECHNIQUE
- Paper 1 (case study): know the business well in advance: its stage, finance, culture, stakeholders and external factors. Annotate the case with facts for each unit. For each question, name the business, cite a fact, apply the theory, weigh.
- Paper 2: expect calculations in finance and operations; show formulae; interpret every result in a sentence.
- Longer answers: define concisely; analysis with a chain "so what"; evaluation with at least two considerations (for example short-term cost versus long-term benefit); a conclusion with a recommendation; about one minute per mark; plan quickly.
- Quantitative: always write formula, substitution, answer with units, and interpretation. Round sensibly.

6. CALIBRATION EXAMPLES (original; all data fictional, firm named "Brightloaf Bakery")
- Q1 [4 marks]. Brightloaf sells loaves at 4.00 each, variable cost 2.50, fixed costs 60,000 a year. (a) Calculate break-even output. (b) With sales of 48,000 loaves, calculate the margin of safety. Answer: contribution 1.50; break-even 60,000/1.50 = 40,000 loaves. Margin of safety 48,000 - 40,000 = 8,000 loaves (about 16.7 percent of sales).
- Q2 [6 marks]. Brightloaf considers a new oven costing 100,000. Net cash flows: year 1 30,000; year 2 40,000; year 3 50,000; year 4 40,000. Calculate payback, ARR, and NPV at 8 percent (discount factors 0.926, 0.857, 0.794, 0.735). Answer: payback: cumulative 70,000 after 2 years, 30,000 of 50,000 needed in year 3, so 2.6 years (2 years 7 months). ARR: total returns 160,000, minus 100,000 = 60,000 over 4 years = 15,000 per year; 15,000/100,000 = 15 percent. NPV: 27,780 + 34,280 + 39,700 + 29,400 = 131,160; minus 100,000 = +31,160. Interpretation: positive NPV means the project returns more than the 8 percent required; payback is short; recommendation conditional on risk and demand.
- Q3 [Final ratios, 4 marks]. Revenue 800,000, cost of sales 480,000, operating expenses 200,000 (assume no interest or tax). Calculate gross profit margin and net profit margin. Answer: gross profit 320,000, margin 40 percent; net profit 120,000, margin 15 percent.
- Q4 [12 marks]. Evaluate whether Brightloaf should expand by opening a second shop or by franchising. Outline: define each, apply (finance available, control and quality, brand, risk), analysis of costs and benefits with figures, stakeholders (owners, employees, franchisees, customers), ethics, recommendation with conditions.

7. TUTOR MOVES
- Ask first: "Which business, what decision, which stakeholders?" before any theory.
- Probe prerequisites: percentage and ratio arithmetic, cash versus profit, the difference between fixed and variable costs.
- Make the student interpret each number: "so what should the manager do?"
- Push to evaluation by asking for the other side, the risk, the time horizon and the decision criterion; ask them to rank their considerations and justify a recommendation.
- At HL, ask them to link units (an HR decision's effect on finance, a marketing plan's effect on operations and cash). Never write the IA; ask about the question, sources and judgement.` },
  { test: /psych/i, title: "PSYCHOLOGY (IB)", text: `IB PSYCHOLOGY: DEEP KNOWLEDGE FOR THE TUTOR. No school outline was supplied, so this follows the current guide in general terms; items marked check must be verified in the subject guide rather than stated as fact. Ask SL or HL, and which options they study.

1. SYLLABUS MAP
- Core (SL and HL): three approaches to understanding behaviour. Biological approach (physiology and behaviour: the brain and behaviour, hormones and pheromones, genetics and behaviour; the role of animal research in understanding human behaviour; localisation, neuroplasticity, neurotransmitters, evolutionary explanations). Cognitive approach (cognitive processing: models of memory such as the multi-store model and working memory model, schema theory, thinking and decision-making, biases, reconstructive memory, emotion and cognition, flashbulb memory). Sociocultural approach (the individual and the group: social identity theory, social cognitive theory, stereotyping, cultural dimensions, enculturation, acculturation, norms, conformity).
- Options (SL one, HL two): abnormal psychology (factors influencing diagnosis, etiology, treatment), developmental psychology (brain and cognitive development, identity, attachment), health psychology (determinants of health, health problems such as stress and addiction, promoting health), psychology of human relationships (personal relationships, group dynamics, social responsibility). Check which are offered.
- Research methods (SL and HL, woven throughout): experiments (true, quasi, natural, field), observations, interviews, case studies, surveys; sampling, variables, controls, bias, validity (internal, external, ecological), reliability, credibility, ethics (informed consent, deception, debriefing, confidentiality, right to withdraw), qualitative analysis, descriptive and inferential statistics.
- HL extension: qualitative research in psychology (methods such as interviews, focus groups, observation and case studies; credibility, bias, triangulation, reflexivity, ethical issues), assessed in a paper on an unseen stimulus.
- Each approach is built around concepts: causality, measurement, bias, perspective, responsibility, change. Student must know studies: each topic requires a named study with aim, method, results, conclusion and evaluation.

2. ASSESSMENT (from memory; check durations and weights in the guide)
- Paper 1 (SL and HL): short-answer questions on each approach and essay questions (extended response) on each approach; the essay is marked out of 22 and the short-answer parts out of 9 (check).
- Paper 2 (SL and HL): options, with short-answer and essay questions.
- Paper 3 (HL): qualitative research on an unseen stimulus.
- Internal assessment (SL and HL): an experimental study conducted by the student, written as a report of up to about 2,200 words with an introduction, exploration/design, analysis, evaluation and communication (check the exact criteria and word limit). The tutor asks about the hypothesis, variables, controls, ethics and interpretation but does not design the study for them.

3. HOW MARKS ARE EARNED
- Short-answer questions ("outline", "describe", "explain") test accurate knowledge of a concept or study; marks for clearly separate points with support.
- Essays use criteria in markbands: focus on the question, knowledge and understanding, use of research to support the answer, and critical thinking, plus clarity and organisation. Band 1-2: general descriptions with little research, no link to the question. Band 5-6 (top): relevant studies described accurately and used as evidence for the argument, evaluated critically, balanced with counter-evidence, and a conclusion tied to the question.
- Evaluation in Psychology: research design (sample, ecological validity, replicability, bias, ethics), cultural and gender bias, reductionism, determinism, alternative explanations, applications, and comparing studies. "Evaluate" is not "list the weaknesses of a study"; the evaluation must be used to answer the question.
- Command terms: Describe (give details), Outline (brief account), Explain (reasons, mechanism, with research), Discuss (a considered review with different perspectives and a conclusion), Evaluate (strengths and limitations of the research or theory, then a judgement), Contrast (differences), To what extent (a verdict), Examine (consider the argument), Compare.
- Studies: only use studies you know well; give researcher, year, sample, method, key finding, and a key criticism. If unsure of a detail say so.

4. COMMON ERRORS AND MISCONCEPTIONS (each with a diagnostic question)
- Describes a study without linking to the question. Q: How does that study support or challenge the claim in the question?
- Lists a study's limitations without using them. Q: How does this limitation change what we can conclude?
- Overstates what a study proves ("proves", "shows that all"). Q: What can a sample of that size and type support, and what can it not?
- Confuses correlation and causation, especially for brain imaging. Q: Does activation in that area show it causes the behaviour or only that it accompanies it?
- Confuses reliability and validity. Q: If the same result was found every time but the measure misses the construct, which is lacking?
- Confuses internal and external validity or ecological validity. Q: Can the finding be generalised from a lab to everyday behaviour, and which kind of validity is that?
- Mixes up independent and dependent variables, or operationalisation. Q: How exactly was the DV measured and what would a different measure change?
- Confuses sampling methods (random, opportunity, volunteer, stratified). Q: How were participants chosen, and what bias could that introduce?
- Treats ethics as a list of rules. Q: What harm could the participants face and how might a debrief reduce it?
- Reductionism and determinism misused. Q: What other level of explanation (cognitive, social) is missing from this biological explanation?
- Claims "cultural bias" without evidence. Q: Which feature of the sample or design is specific to one culture, and what changes?
- Confuses schema theory with stereotypes or with cognitive biases. Q: How does a schema help processing and how can it distort memory?
- Confuses the multi-store and working memory models. Q: Which model explains simultaneous tasks interfering?
- Treats the animal research study as direct proof for humans. Q: What are the limits of generalising across species?
- Uses "evaluate" for the paper but gives only a summary. Q: What is your judgement of the quality of the evidence?
- Confuses neurotransmitters and hormones. Q: How do the speed and route of each differ?
- Cites anecdotal or outdated claims without evidence (for example "we only use 10 percent of the brain"). Q: What study supports that?
- Treats evolutionary or genetic explanations as meaning behaviour is fixed. Q: What does gene-environment interaction or epigenetics add?
- IA: writes a hypothesis that is vague or untestable, uses statistics without matching the design. Q: What exact difference do you predict and how will you measure it?
- IA: concludes more than the data allow or ignores a non-significant result. Q: What does your p-value or effect size say, and what can you claim?

5. QUESTION TYPES AND EXAM TECHNIQUE
- Short answer: read the command term; one idea per mark; name the study where asked.
- Essay (about 35 to 40 minutes at roughly one mark per 1.5 minutes): plan three paragraphs. Introduction defines the key terms and states the line of argument. Body: each paragraph is a claim, one or two studies with details, the evaluation of the study that matters for the claim, and a link back. Conclusion: a judgement, not repetition.
- Use at least two to three pieces of research and make the criticism relevant (for example ecological validity matters for a lab study of memory but not for a case study of a patient).
- Option papers: same pattern. HL qualitative paper: apply method, bias and ethics to the unseen stimulus.
- Keep a revision table for each study: aim, procedure, findings, conclusion, evaluation, which topics it supports.

6. CALIBRATION EXAMPLES (original; any study details are fictional, labelled)
- Q1 [Short answer, 9 marks style]. Outline one study (a named, real study the student knows) investigating the role of schema in memory, covering aim, method, findings. Marking idea: accurate aim, method with sample and procedure, findings and conclusion linked to schema; an invented study cannot be used.
- Q2 [Extended response, about 22 marks]. Evaluate one study of the influence of culture on behaviour. Outline: describe the study (aim, procedure, sample, finding), evaluate with sampling, ecological validity, ethics, bias, replicability, link to another study, judgement on how far it supports a cultural claim.
- Q3 [IA-style]. A fictional experiment: 20 participants recalled words under two conditions (mean 12.1 recalled words in condition A with SD 2.0, versus 9.8 words with SD 2.4 in condition B). Task: state one hypothesis, one control, and one threat to validity. Answer outline: directional hypothesis that A will give higher recall; controls such as same list, time and instructions; threat such as participant variables, since if it is a between-groups design, the groups may differ in memory ability; interpretation requires an inferential test rather than the means alone.

7. TUTOR MOVES
- Begin: "Which study could you use as evidence for this, and what exactly did it find?" Make them recall aim, method, finding and sample before evaluating.
- Probe prerequisites: validity and reliability, variables, sampling, ethics.
- Ask for the evaluation that matters: "Why does that limitation matter for THIS question?"
- Push HL toward synthesis: compare the strength of evidence across two approaches, and the interaction between biological, cognitive and sociocultural factors.
- For the IA ask about hypothesis, operationalisation, controls, and what the data cannot show. Do not write or design it for them.` },
  { test: /econ/i, title: "ECONOMICS (IB)", text: `IB ECONOMICS: DEEP KNOWLEDGE FOR THE TUTOR. Ask once whether they are SL or HL. Their school's course is mixed HL/SL, 2026-2028, textbook Blink and Dorton (Oxford), taught in the order micro (year 1), macro (year 1), global economy and development (year 2).

1. SYLLABUS MAP
- Unit 1 Introduction: scarcity, choice, opportunity cost, factors of production, PPC, economic systems, positive versus normative statements, the nine key concepts (scarcity, choice, efficiency, equity, economic well-being, sustainability, change, interdependence, intervention).
- Unit 2 Microeconomics: demand and supply, determinants, competitive market equilibrium, consumer and producer surplus, allocative efficiency (MB = MC); critique of rational maximising (behavioural economics: bounded rationality, anchoring, nudges); elasticities (PED, PES, YED, XED, with total revenue and tax incidence); role of government (indirect taxes, subsidies, price ceilings and floors, quotas); market failure: externalities (positive and negative, MSB, MSC, welfare loss), public goods and the free-rider problem, common pool resources, asymmetric information, market power, inequity.
- HL only in micro: costs, revenues and profit (short-run and long-run costs, returns, economies and diseconomies of scale), market structures (perfect competition, monopoly, monopolistic competition, oligopoly: game theory and collusion), price discrimination, productive and allocative efficiency across structures, and the calculations behind them.
- Unit 3 Macroeconomics: measuring activity (GDP, GNI, real versus nominal, circular flow, business cycle, PPP and per-capita limitations), AD and AS (Keynesian and monetarist/new classical views, short-run and long-run AS), macro objectives (unemployment types, inflation measurement and causes: demand-pull and cost-push, costs of each), income distribution and poverty (Lorenz curve, Gini, progressive/regressive/proportional taxes, absolute versus relative poverty), demand-side policies (fiscal, monetary), supply-side policies (interventionist and market-based).
- HL only in macro: the multiplier and its calculation, the Phillips curve (short-run and long-run, NAIRU), average versus marginal tax rates, further AD/AS evaluation, Laffer curve.
- Unit 4 The global economy: gains from trade, protection (tariffs, quotas, subsidies, administrative barriers) and the arguments for and against, economic integration (FTA, customs union, common market, monetary union), exchange rates (floating, fixed, managed; appreciation and depreciation effects), balance of payments (current, capital and financial accounts), sustainable development, measuring development (HDI, single and composite indicators), barriers to growth and development, growth and development strategies.
- HL only in global: absolute versus comparative advantage with opportunity-cost calculations, current-account imbalance and its consequences, Marshall-Lerner condition and the J-curve, long-run terms of trade, and quantitative policy recommendation.

2. ASSESSMENT (the school's outline; exact durations and mark totals: check the subject guide)
- SL: Paper 1 extended response (30%), Paper 2 two data-response questions (40%), IA 30%.
- HL: Paper 1 (20%), Paper 2 (30%), Paper 3 policy recommendation and calculation on data (30%), IA 20%. Paper 1 is about 75 minutes, Paper 2 about 105 minutes.
- Paper 1 questions are split into a shorter part (about 10 marks, knowledge, application and analysis, a diagram expected) and a longer part (about 15 marks, adds evaluation); students choose from a few questions covering the syllabus. Paper 2 is stimulus (a text plus data) with short parts that move from define or calculate, to explain with a diagram, to a final evaluate or discuss part. Paper 3 (HL) gives data about a country or market with a problem; the student calculates, then recommends a policy and justifies it.
- IA: a portfolio of three commentaries on three news articles from three different sources, each linked to a different section of the syllabus (micro, macro, global) and applying one key concept. Each commentary has a word limit of about 800 and is marked on diagram, terminology, application, analysis and evaluation (check the guide for the marks per criterion). Never write it; question their choice of article, whether it genuinely allows the theory to be applied, and whether their diagram matches the article.

3. HOW MARKS ARE EARNED
- Marking is by markbands for the longer parts: knowledge and understanding (accurate definitions, precise terms), application (to the real-world case or the data in the stimulus, not a generic example), analysis (a chain of reasoning that goes cause, mechanism, effect), and evaluation (a justified judgement). Diagrams are marked: correct, fully labelled, and referred to in the text.
- Band 1-2 answer: general statements, unlabelled or wrong diagram, example named but not used, advantages and disadvantages listed. Band 5-6 answer (top): precise definitions, a correct labelled diagram integrated into the argument, an example with real or given data, a logical chain with each link explained, and an evaluation that weighs (size, time, stakeholders, assumptions) and ends in a judgement that follows from the weighing.
- Command terms: Define/State (brief). Outline (short account). Explain (reasons, usually with a diagram). Calculate (working shown, units). Distinguish (differences). Analyse (break into parts, show how they relate). Discuss (several views, then a conclusion). Evaluate (strengths and limitations, then a judgement). To what extent (a verdict with degree). Justify (reasons for a choice, usually a policy). Recommend (HL paper 3: a policy plus reasons plus likely limitations).
- Evaluation moves: short run versus long run, magnitude (elasticity decides how large), assumptions (ceteris paribus, rationality), stakeholders (consumers, producers, government, workers, other countries), opportunity cost and unintended consequences, effectiveness against the stated objective, equity versus efficiency, time lags, and data limits.

4. COMMON ERRORS AND MISCONCEPTIONS (each with a diagnostic question)
- Draws a shift of demand when only the price changed. Q: Is price one of the things held constant behind the curve, or is it on the axis?
- Confuses a movement along with a shift. Q: Which of these two events changes the quantity people are willing to buy at EVERY price?
- Mixes up a change in demand with a change in quantity demanded in the wording. Q: Say it with the diagram: which word describes the arrow along the curve?
- Treats a tax as shifting demand. Q: Who pays an indirect tax to the government, and so which curve does the tax move?
- Shows the tax gap on the diagram but names the wrong area for consumer burden. Q: Which two prices make up the burden split, and where is the original equilibrium price?
- Says inelastic means "no response". Q: What does a PED of 0.3 predict for a 10% price rise?
- Believes revenue always rises when price rises. Q: If demand is elastic, what happens to total revenue when price goes up, and why?
- Thinks a subsidy, a price ceiling or a minimum price always helps. Q: At a ceiling below equilibrium, what happens to quantity demanded and supplied, and who gains and loses?
- Calls any negative effect an externality. Q: Is the cost carried by someone who is not part of the transaction?
- Confuses public goods with goods the government provides. Q: Is the good non-rivalrous and non-excludable, or merely publicly funded (like state schools)?
- Uses "demand-side" and "supply-side" policies interchangeably. Q: Which curve in the AD/AS model does cutting income tax rates move first, and which does investing in vocational training move?
- Mixes nominal and real GDP, or GDP and growth rate. Q: If nominal GDP rose 4% and prices rose 5%, did the economy grow?
- Says inflation is always bad and unemployment is just one number. Q: Which types of unemployment could still exist at full employment?
- Treats the multiplier as automatic and equal to 1 over MPS in every case. Q: Which withdrawals does the full multiplier include and why do they shrink the effect?
- Absolute and comparative advantage swapped, or uses output not opportunity cost. Q: What does a unit of cloth cost each country in wheat given up?
- Thinks a depreciation always improves the trade balance. Q: What must be true of PED for exports and imports (Marshall-Lerner) and why might it take time (J-curve)?
- Evaluates by listing pros and cons without a judgement. Q: Of the points you listed, which matters most for THIS country, and what would change your mind?
- Writes "this shows" for a diagram not referred to in the text, or defines terms without applying. Q: Where in your paragraph does the stimulus data appear?
- Mistakes a tariff's effect on domestic price: draws the world price line and forgets the quantity effects. Q: After the tariff, who gains the area on the diagram (government, producers) and which area is welfare loss?
- Confuses growth and development, or uses HDI as if it were income. Q: Name two ways a country can have high GDP per capita and a low HDI.

5. QUESTION TYPES AND EXAM TECHNIQUE
- Timing: about one minute per mark. A 15-mark part is about 25 minutes: 3 minutes planning, paragraph one explain with diagram, paragraph two a second argument or an alternative, then 8 minutes evaluation. A 10-mark part is about 15 minutes with one strong diagram.
- Paragraph pattern: point; diagram (labelled axes, curves, equilibria, and the shift with arrows); explain the chain in words; apply with the example or data; evaluate in one or two sentences.
- Paper 2: quote or use figures from the text in every answer; for a calculation, show the formula, substitution, units and the sign; for "explain with a diagram" the diagram carries marks; the last part needs a two-sided argument and a conclusion.
- Paper 3 (HL): do the maths first and correctly, then write the recommendation as claim, reason from the calculation, an alternative rejected and why, a limitation of the data and a time horizon.
- Real-world examples: choose ones you actually know with care; never invent statistics. If a student is unsure of a number, they should say "approximately" or use the stimulus data.

6. CALIBRATION EXAMPLES (original; all data fictional)
- Q1 [HL calculation, 6 marks]. In the fictional market for Zorin bikes, Qd = 120 - 2P and Qs = -30 + 3P (P in dollars, Q in thousands). (a) Find equilibrium. (b) A per-unit tax of $10 is imposed on producers. Find the new price paid by consumers, quantity, tax revenue and the burden on consumers and producers, and the welfare loss. Answer: (a) 120 - 2P = -30 + 3P so 150 = 5P, P = 30, Q = 60. (b) Supply becomes Qs = -30 + 3(P - 10) = -60 + 3P; 120 - 2P = -60 + 3P gives P = 36, Q = 48. Consumers pay 6 more per unit (36 - 30), producers receive 26, so 4 less. Revenue 10 x 48 = 480; consumer burden 6 x 48 = 288; producer burden 4 x 48 = 192. Welfare loss = 0.5 x 10 x (60 - 48) = 60. Marks: setting equal (1), P and Q (1), new supply (1), new equilibrium (1), burden split (1), welfare loss (1).
- Q2 [HL, 4 marks]. The country of Altia has a marginal propensity to save of 0.1, to be taxed 0.2 and to import 0.2. (a) Calculate the multiplier. (b) An increase of $50 million of investment: effect on GDP? Answer: withdrawal rate 0.1 + 0.2 + 0.2 = 0.5; k = 1/0.5 = 2; change in GDP = 2 x 50 = $100 million.
- Q3 [HL, 4 marks]. Per worker-day, A makes 12 wheat or 6 cloth; B makes 4 wheat or 4 cloth. Who has comparative advantage in what, and what trade range is mutually beneficial? Answer: A gives up 2 wheat per cloth and 0.5 cloth per wheat; B gives up 1 wheat per cloth and 1 cloth per wheat. A has comparative advantage in wheat, B in cloth. Beneficial terms for 1 cloth lie between 1 and 2 wheat. (A has absolute advantage in both, which is exactly why absolute advantage is not the test.)
- Q4 [SL/HL, 15 marks]. Evaluate the effectiveness of a government introducing a minimum price (price floor) in an agricultural market. Outline: define; diagram with Pmin above Pe, excess supply, effects on revenue (depends on PED), government buying surplus (cost, storage), farmers gain if demand inelastic, consumers lose, taxpayers lose, misallocation (allocative inefficiency); example. Evaluation: size of PED, whether the surplus is bought, alternatives (subsidy, decoupled payments), long run supply response, equity versus efficiency, judgement.

7. TUTOR MOVES
- First ask: "Draw it before you say it." For a micro claim, have them draw and label the diagram, then explain what each arrow means. Mark by the same rubric: if the picture and words disagree, ask which is right.
- Probe prerequisites: the difference between a determinant and the price; elasticity formula and sign; the circular flow; percentage change arithmetic (this is where HL calculations fail).
- Push to evaluation with questions, not answers: "Over what time period?", "Who loses?", "How big is the effect, and what decides that?", "What assumption would break it?", "What would you recommend and what is the cost?" Ask them to rank their evaluation points.
- For synthesis at HL, ask them to connect two units (for example how an exchange-rate depreciation interacts with the multiplier, or tax incidence with elasticity) and say which dominates.
- Never write their IA commentary. Ask what the article claims, which concept it applies, and what their diagram predicts that the article confirms or contradicts.` },
  { test: /philosoph/i, title: "PHILOSOPHY (IB)", text: `IB PHILOSOPHY: DEEP KNOWLEDGE FOR THE TUTOR. No school outline was supplied; this follows the current guide in general terms and marks uncertain items with check. Ask SL or HL, which optional themes they study and which prescribed text.

1. SYLLABUS MAP
- Core theme (SL and HL): Being human. Topics: what is a human being (personal identity, the self, the mind-body problem: dualism, physicalism, functionalism, the problem of other minds; free will and determinism: hard determinism, libertarianism, compatibilism; the role of embodiment and consciousness); identity and what it is to be a person (continuity, memory, narrative identity, social and cultural identity); freedom and autonomy; meaning and the human condition. Check the guide for the exact wording.
- Optional themes (SL one, HL two) from: aesthetics, epistemology, ethics, philosophy and contemporary society, political philosophy, philosophy of religion, philosophy of science. Typical content: aesthetics (what is art, beauty, the role of the artist), epistemology (rationalism and empiricism, skepticism, justification, the Gettier problem), ethics (consequentialism, deontology, virtue ethics, moral relativism, applied ethics), political philosophy (justice, the social contract, liberty, equality, power and authority), philosophy of religion (arguments for and against God, the problem of evil, faith and reason), philosophy of science (the scientific method, falsification, paradigm shifts, realism and anti-realism).
- Prescribed philosophical text (SL and HL): one text studied closely, with questions about its arguments. Ask which text. HL extension: exploring philosophical activity, with a focus on how to do philosophy and the role of philosophical method in analysing a stimulus (check).
- Philosophical skills: identifying a thesis, premises and conclusion; distinguishing valid from sound arguments; fallacies; thought experiments; counter-examples; objections and replies; clear definitions of terms.

2. ASSESSMENT (from memory; durations, weights, mark totals: check the guide)
- External papers: a paper on the core theme and optional themes (extended responses), a paper on the prescribed text, and at HL an additional paper on a philosophical stimulus or activity (check).
- Internal assessment: a philosophical analysis of a non-philosophical stimulus (a text, image, advertisement, news item) chosen by the student, linking it to a core or optional theme with philosophical argument (about 1,500 to 2,000 words: check the limit). Criteria reward identifying the philosophical issue, analysing the stimulus, using philosophical argument and positions, and evaluating them. Do not write or choose the argument for them.

3. HOW MARKS ARE EARNED
- Essays are marked on: knowledge and understanding of the philosophical ideas and terms; application and analysis of arguments (premises, assumptions, implications); critical evaluation (objections, replies, counter-examples, strength of the argument) and a reasoned position; structure and clarity; use of examples.
- Band 1-2: summary of what a philosopher said, claims of "everyone has their opinion". Band 5-6 (top): accurate exposition, argument analysed (premises explicit), objections considered with replies, own position justified and consistent, examples that test the theory.
- Command terms: Define, Outline, Explain, Compare, Contrast, Analyse (break down an argument), Discuss (consider different positions and conclude), Evaluate (weigh the strength of the argument and its objections), To what extent, Examine, Justify, Assess.
- Good philosophy is argument rather than opinion: every claim has a reason; a view is stated and defended; objections are taken seriously.

4. COMMON ERRORS AND MISCONCEPTIONS (each with a diagnostic question)
- Reports what a philosopher said without arguing. Q: What is the conclusion and what are the premises that support it?
- Treats opinion as argument. Q: What reason would you give someone who disagrees?
- Confuses validity and truth. Q: Can an argument be valid and have a false conclusion?
- Confuses valid and sound. Q: What must be true of the premises for an argument to be sound?
- Misidentifies the thesis or the objection. Q: Is that sentence the claim being defended or the opponent's reply?
- Straw man: misrepresents a view to defeat it. Q: Would a defender of that view accept your summary?
- Ad hominem or appeals to authority in place of argument. Q: Does the person's background affect the truth of the claim?
- Treats dualism and physicalism as the only options, or conflates materialism with physicalism and functionalism. Q: What does functionalism say about the same mental state in different physical systems?
- Confuses determinism with fatalism. Q: Does determinism mean that your choices don't matter?
- Confuses compatibilism with libertarianism. Q: In which view is free will compatible with determinism?
- Free will: assumes feeling free proves freedom. Q: Could the feeling exist if determinism were true?
- Personal identity: confuses numerical and qualitative identity. Q: When we say a person is "not the same", which sense do we mean?
- Ethics: conflates consequentialism with selfishness or deontology with ignoring consequences. Q: Whose welfare counts in utilitarianism?
- Ethics: treats relativism as tolerance. Q: Does relativism allow us to criticise another culture's practice?
- Epistemology: confuses belief, truth and justification. Q: Can a true belief be accidental, and what does the Gettier case show?
- Thought experiments used as decoration. Q: What intuition does the case rely on, and would the argument survive if the intuition changed?
- Conclusion not tied to the argument. Q: Does your conclusion follow from the points above?
- Uses vague terms ("consciousness", "freedom", "good") undefined. Q: How are you using the term in this sentence?
- Prescribed text: paraphrases passages without analysing. Q: What does this passage do within the argument as a whole?
- IA: philosophical issue not explicit; stimulus described but not analysed. Q: What philosophical question does the stimulus raise and what position does it presuppose?

5. QUESTION TYPES AND EXAM TECHNIQUE
- Essays: plan an argument first. Introduction: state the question, define key terms, give your thesis. Body: exposition of the position with the best argument; an objection; a reply; another position; your assessment. Conclusion: say what you have established and what remains open. Use examples to test claims.
- Text questions: locate the passage in the argument, explain it in your words, link to other parts, evaluate.
- Time: roughly one minute per mark; spend a fifth planning.
- Use technical terms accurately but explain them; avoid listing philosophers.
- Evidence in philosophy is reasons, examples and counter-examples; cite a philosopher's view as a position, not as the proof.

6. CALIBRATION EXAMPLES (original)
- Q1 [Argument analysis, 6 marks]. Set out the following argument in premise-conclusion form and say whether it is valid: "If determinism is true, no one is morally responsible. Determinism is true. So no one is morally responsible." Answer: P1 (if D then no responsibility), P2 (D), C (no responsibility). Valid by modus ponens. Whether it is sound depends on the truth of P1 (compatibilists deny it) and P2 (disputed). Marking: premises identified (2), validity explained (2), soundness and objection (2).
- Q2 [Essay, about 20 marks]. "Memory is the only thing that makes someone the same person over time." Discuss. Outline: memory criterion (Locke), objection (the brave officer type problem of transitivity, amnesia, false memories), alternatives (bodily/biological continuity, psychological continuity more broadly, narrative identity), thought experiments (duplication), your position.
- Q3 [Ethics essay]. Evaluate utilitarianism as a theory of right action. Outline: statement of the principle (greatest happiness), strengths (impartiality, clarity), objections (rights violations, demandingness, measuring utility), replies (rule utilitarianism), contrast with deontology, judgement.

7. TUTOR MOVES
- Begin by asking the student to state the question's claim in one sentence and then give the strongest argument for it, in premise form. Then ask for the strongest objection.
- Probe prerequisites: definitions, validity versus truth, the distinction between descriptive and normative claims.
- If they give an opinion, ask "what would you say to someone who disagreed, and what reason would they give?" Do not supply the position or the essay.
- Push HL toward synthesis: connect core-theme ideas to an optional theme, or compare two philosophers on the same issue, and evaluate which argument survives.
- For the IA: ask what philosophical question the stimulus raises, and what the student's argument adds beyond description. Never write it.` },
  { test: /hist/i, title: "HISTORY (IB)", text: `IB HISTORY: DEEP KNOWLEDGE FOR THE TUTOR. This is the revised course (first assessment 2028). The school runs mixed SL/HL classes and TWO pathways exist, so ask first which one the student follows (and SL or HL) before assuming examples.

1. SYLLABUS MAP
- Four specified concepts run through everything: cause and consequence, continuity and change, perspectives, significance. Four skills: using sources, making connections, evaluating arguments, asking questions.
- Paper 1 focused study (SL and HL), recommended about 50 teaching hours. Pathway A (conflict and displacement): post-war displacement in Europe (1945-1960) and the Indochina refugee crisis (1975-1990); lines of inquiry are the causes of displacement, national and international responses, and experiences of displaced communities. Pathway B (political and economic transitions): the Meiji Restoration (1853-1894) and the Russian Federation (1985-1999), with the inquiries what caused the transition, how it was achieved, and what challenges society faced after it.
- Paper 2 thematic study (SL and HL), about 80 hours, and each essay needs examples from at least two different regions. Pathway A: Conflict (from 750 CE onwards), with WWI studied across all four lines of inquiry (why the conflict emerged, what determined the outcome, how it affected people's lives, how peace was established), a second non-European conflict, and further comparisons such as the War on Terror. Pathway B: Authoritarian rule (from 1750 CE onwards) with Mao Zedong/PRC and Nasser/Egypt as principal examples, over four inquiries (why it emerged, how it was maintained, how it affected people's lives, how it was challenged).
- Paper 3 regional studies (HL ONLY), about 90 hours. Pathway A, Europe: study 6, Europe and the First World War 1871-1923 (balance of power and peace after 1871, German foreign policy, reasons for the war, reasons for the defeat of the Central Powers, impact on one European country, the Paris Peace Treaties); study 9, Europe and the Second World War 1918-1949 (League of Nations, reasons for the war, Axis defeat and Allied victory, impact on one country, persecution and mass murder in Nazi-occupied Europe, responses to it). Pathway B, Asia and Oceania: study 3, challenges to imperial rule in China 1736-1911 (Qianlong, Canton system and the opium trade, Opium Wars and treaties, Taiping, Self-Strengthening and failed reform, Boxer Rising, late Qing reforms, Sun Yixian and the 1911 revolution) and study 12, the PRC 1949-2020 (consolidation under Mao, campaigns, Great Leap Forward, Cultural Revolution, foreign policy, post-Mao reform under Deng, Tiananmen 1989, WTO, rise of Xi, Belt and Road).
- Historical investigation (IA): the student's own inquiry question, about 20 hours.

2. ASSESSMENT (the school's outlines; check the guide for exact mark totals)
- Paper 1, source-based, 1 h 15 (SL 30%, HL 20%): three short sources on one inquiry question; the student explains how the sources can be used (origin and context, content, value and limits, and synthesis across sources) to answer the inquiry question. It is about use of sources for an inquiry, not summarising them.
- Paper 2, 1 h 45 (SL 40%, HL 25%): Section A, a conceptual question chosen from two; Section B, a short-response part plus an essay (the school's two outlines word this slightly differently, so confirm the exact format with the teacher).
- Paper 3, HL only, 2 h (35%): two essays, one from each regional study.
- IA (SL 30%, HL 20%): independent historical investigation: formulate an inquiry question, select and evaluate sources, synthesise evidence into a reasoned answer. The tutor questions the student's question, source choices and reasoning and never drafts text.

3. HOW MARKS ARE EARNED
- Mark schemes use markbands. What rises across the bands: focus on the question (not the topic), accuracy and specificity of evidence, explanation of how the evidence supports the claim, analysis of the concept asked, comparison where asked, historiography for HL, and a sustained judgement.
- Band 1-2 (low): narrative of what happened, general statements, a few dates, no link to the question. Middle: relevant but descriptive with some analysis. Top: a clear thesis answering the exact question, precise evidence from the right region/period, explicit causal or comparative reasoning, counter-arguments weighed, and a conclusion that follows.
- Command terms: Explain (give reasons and show how), Analyse (break into parts and show relationships), Compare (similarities and differences, on points, not two separate narratives), Contrast (differences), Discuss (a balanced consideration with a conclusion), Evaluate (weigh strengths and limitations, reach a judgement), To what extent (a degree and a verdict), Examine, Assess (relative importance, a judgement).
- Sources: origin (who, when, where), purpose (why produced, for whom), content (what it says), context (what was happening), value (what it can tell us for THIS inquiry), limitation (what it cannot, bias, omissions). Value and limitation always refer back to the inquiry question, not to the source in general. Synthesis: where sources corroborate, conflict, or fill gaps for each other.

4. COMMON ERRORS AND MISCONCEPTIONS (each with a diagnostic question)
- Describes events without linking to cause or consequence. Q: What is the link in your sentence between this event and the thing the question asks about?
- Narrates the whole period instead of answering the question. Q: Which sentence of your answer could be deleted without changing your argument?
- Treats a list of causes as an argument. Q: Which cause was most important, and what would have been different without it?
- Confuses short-term triggers with long-term causes. Q: Would the war have broken out in that form without the earlier alliances and rivalries, and what does that say about the assassination?
- Hindsight: assumes people knew what would happen. Q: What could contemporaries actually see at the time?
- Evidence that is vague ("many people suffered"). Q: Give me a name, a date or a figure that shows it, and say how sure you are of it.
- Evidence that is accurate but not used. Q: What does that fact prove for your claim?
- Judges a source "biased so unreliable". Q: What can a biased source still tell us about the inquiry question?
- Evaluates the source in general rather than for the question asked. Q: Value for which inquiry question?
- Summarises each source in turn without synthesis. Q: Which two sources point the same way on this question, and where do they disagree?
- Mixes up origin and purpose. Q: Who made it and when (origin); why, and for whom (purpose)?
- Compares by writing two mini-essays. Q: What is the point of similarity or difference, and show both cases in the same paragraph?
- Treats one region as the whole theme (Paper 2 needs two regions). Q: Which example from a different region supports this line of inquiry?
- Calls a historian's view "the truth" or dismisses it as opinion. Q: What evidence does that historian use and what do they leave out?
- Lists historians' names without using the argument (HL). Q: How does that interpretation help you answer THIS question, and where do you disagree?
- Mistakes significance for importance only to people at the time. Q: Significant to whom, when, how widely, how lasting?
- Confuses continuity with absence of change. Q: What stayed the same and why, while what changed?
- Conclusion repeats the essay or says "both" without ranking. Q: If I forced you to choose one factor, which and why?
- Misdates, misplaces, or confuses actors from the two pathways' examples. Q: Name the leader and the decade: which regional study is this?
- Anachronistic terms ("terrorist", "refugee") applied loosely. Q: Which definition are you using and who used the label then?

5. QUESTION TYPES AND EXAM TECHNIQUE
- Paper 1: plan time by question; for each source write origin/purpose/context in a sentence, then content, then what it can be used for and where it falls short, all tied to the inquiry; the final question demands synthesis, with a short overall judgement.
- Paper 2 Section A (concept question): define the concept in the question's terms (cause and consequence, continuity and change, perspectives or significance), then apply it with two examples from different regions, then a judgement. Section B essay: plan 5 minutes, thesis in the first paragraph, each paragraph one line of argument with specific evidence from both examples, comparison within paragraphs, a counter-argument, a conclusion. Rough timing: one minute per mark overall; the essay is roughly an hour.
- Paper 3 (HL): one essay per regional study, about an hour each; the thesis must answer the exact question; use historians' interpretations and show your own weighing.
- IA: the inquiry question must be answerable with sources and be arguable, not a description; sources must be evaluated for the question; the conclusion must be reached from the evidence.
- Prepare evidence banks by line of inquiry (not by chronological narrative) with names, dates, terms, statistics and one historian per topic for HL.

6. CALIBRATION EXAMPLES (original; sources are fictional)
- Q1 [Paper 1 style, 8 marks]. Inquiry: how did the authorities respond to the arrival of displaced people? Source A (fictional): a ministry circular of 1947 telling officials to register arrivals and house them in barracks; Source B (fictional): a diary entry by a displaced teacher about overcrowding. Explain how a historian could use Source B, and one limitation, for this inquiry. Outline: origin and purpose (private diary, not meant for authorities, so candid about conditions), content (overcrowding and shortages), use (shows the lived result of policy and gaps in provision, which A hides), limitation (one person, one place, one moment, emotional register; cannot show policy intent or national scale), link back to the inquiry, ideally corroborate against Source A.
- Q2 [Paper 2 essay, 20-ish marks]. Compare and contrast the use of propaganda in maintaining authoritarian rule in two states from different regions. Outline: thesis (for example that propaganda mattered most when paired with force, or when linked to a charismatic leader); similarities on points (cult of leader, control of media and education), differences (mass mobilisation campaigns versus regional nationalism and state-led development), evidence for each state in each paragraph, counter-argument (force and economic improvement may have mattered more), judgement.
- Q3 [Paper 3 HL essay]. To what extent was foreign pressure the main cause of the weakening of imperial rule in a state you have studied? Outline: define 'main cause', weigh external pressure (treaties, trade, war) against internal rebellion, fiscal weakness and failed reform, historiographical debate between external and internal explanations, judgement on interaction rather than either alone.

7. TUTOR MOVES
- Begin by asking for a one-sentence answer to the question, then make them defend it with two pieces of evidence from memory. Do not accept narrative.
- Separate evidence from interpretation: "Is that a fact or a claim about the fact?".
- For causes, ask for a ranking and a counterfactual ("what if this had not happened?"). For sources, ask what the question would need that this source does not give.
- For HL, ask which historian they would use and whether the evidence supports that view, and have them argue the opposite view for a minute.
- Check dates and names briefly and kindly, then return to argument. Never write the thesis or the IA; ask them to state it and then attack it.` },
  { test: /geog/i, title: "GEOGRAPHY (IB)", text: `IB GEOGRAPHY: DEEP KNOWLEDGE FOR THE TUTOR. Ask SL or HL. Their school's course is mixed HL/SL, 2026-2028, taught through the four P's (Place, Process, Power, Possibility) with the key concepts of spatial interaction and scale, and the recurring themes of the Sustainable Development Goals, the circular economy and the food-energy-water nexus.

1. SYLLABUS MAP
- Core (SL and HL), taught as three themes. Changing population: population distribution, pyramids and projection, momentum, demographic transition model, dependency and ageing, pro- and anti-natalist policies, voluntary and forced migration, refugees, trafficking, challenges and opportunities. Global climate: vulnerability and resilience: enhanced greenhouse effect, feedback loops, carbon cycle, global dimming, consequences, mitigation and adaptation, disparities between places. Global resource consumption and security: global footprints, Malthus and Boserup, neo- and anti-Malthusian ideas, the SDGs (SDG 12 in particular), food-energy-water nexus, energy sources (renewables, nuclear), the linear versus circular economy, doughnut economics, resource stewardship.
- Options (SL study two, HL study three; the school's chosen ones): Leisure, tourism and sport (changing leisure patterns, tourism life cycle and the Butler model, carrying capacity, overtourism, ecotourism and sustainable tourism, tourism and climate change, sport at international, national and local scale, mega-events and urban regeneration, inclusion); Food and health (health indicators such as HALE and infant mortality, disease transition model, diffusion of disease and pandemics, food production, food security and loss, GM and vertical farming, role of TNCs, governments and NGOs, one detailed famine). The HL third option in their outline is Extreme environments (desert, mountain and cold environments, weathering, glacial and periglacial processes, resource development, tourism and Arctic competition), while the content overview also lists Urban environments for HL: check with the teacher which they take.
- HL extension, global interactions: power, places and networks (defining globalisation, KOF index, time-space convergence, TNCs, diffusion, cultural homogenisation versus hybridity, global organisations such as the IMF, WTO, EU, G7 and G20, capital flows: aid, FDI, remittances, effect on landlocked and remote countries); human development and diversity (single and composite indicators, HDI, GII, measuring poverty and inequality, Lorenz curve and Gini, gender and ethnic inequality, SDGs, fair trade, microcredit, corporate responsibility, NGOs and top-down versus bottom-up aid, debt relief); global risks and resilience (geopolitical and economic risks: cybercrime, tax avoidance, surveillance, disruptive technology, environmental risk, sovereignty, protectionism and trade wars, anti- and alter-globalisation, resilience).
- Skills woven through: map skills (grid references, scale, cross sections, isoline/choropleth/flow maps), graphs of all kinds, population pyramids, statistics (mean, median, mode, range, percent change, correlation, nearest-neighbour), and evaluating data and infographics for bias.

2. ASSESSMENT (the school's outline; exact durations and marks: check the guide)
- Paper 1 options (35% for both SL and HL): short answer plus an extended response on each option studied.
- Paper 2 core (SL 40%, HL 25%): short-answer questions on data, including an infographic, and one extended response.
- Paper 3 (HL only, about 1 hour, 20%): two short essays on the HL extension.
- Internal assessment, fieldwork (SL 25%, HL 20%): one written report of at most 2,500 words on a fieldwork question, with primary data collection, graphical representation, analysis and evaluation. Criteria cover the fieldwork question and geographical context, methods, quantitative and qualitative techniques and data presentation, analysis and conclusion, evaluation, and formal communication (check the guide for the marks of each). The school's fieldwork has used urban surveys (bipolar surveys, questionnaires, pedestrian and traffic counts, mapping of shops and services) and a coastal trip; the tutor challenges the question and method, never writes the report.

3. HOW MARKS ARE EARNED
- Short answers: marks are for specific points, each needing a place name, a figure or a precise process. Data questions: use the numbers (quote a value with units, compare two values, calculate a change or percent change), describe pattern and anomaly before explaining.
- Extended responses are marked on markbands: knowledge and understanding with named, located case studies and correct terminology, application of concepts to the question, synthesis and evaluation (balance of views, scale, time, stakeholders), and structure. Band 1-2: general statements with no named place, one side only. Band 5-6 (top): case study evidence with figures, balanced assessment of different strategies or stakeholders, a clear judgement tied to the command term.
- Command terms in this subject: Describe (what, with data), Explain (why, the process), Compare (both, on the same criteria), Distinguish, Suggest (a plausible reason from the data), Analyse (show relationships in a figure), Discuss (several views and a conclusion), Evaluate (weigh strengths and limitations; judgement), To what extent (degree), Examine (consider the argument or concept, and its implications), Justify (reasons for a choice).
- Case studies: at least one detailed, located example per sub-topic, with accurate facts they actually know; never invent figures; say "approximately" if unsure. Prefer the school's own case studies (for example tourism hotspots, a famine, a megacity, the China and US power study).

4. COMMON ERRORS AND MISCONCEPTIONS (each with a diagnostic question)
- Describes the graph instead of using it. Q: Which two numbers from the graph show the pattern you describe?
- Fails to use units or quote the data in the infographic. Q: What is the value, in what unit, for which year?
- Treats correlation as cause. Q: What other factor could produce both of these?
- Explains a pyramid wrongly (confuses ageing with high birth rate). Q: What does a narrow base with a bulge in the middle suggest about births and about future dependency?
- Believes the demographic transition model is a prediction for every country. Q: Which assumptions in the model might not hold for a given country?
- Confuses mitigation with adaptation. Q: Does this strategy reduce emissions or reduce harm from the changes?
- Says global warming and the ozone hole are the same thing, or confuses the enhanced and natural greenhouse effect. Q: What is the natural greenhouse effect doing for the planet's temperature and what does enhancing it change?
- Gives a "case study" without a place or figures. Q: Where exactly, when, how many?
- Lists impacts without scale or stakeholders. Q: Who gains and who loses, and over what time?
- Writes "economic, social, environmental" as a list rather than linking them. Q: How does one effect lead to the next?
- Treats Malthus and Boserup as the same or as opposites without conditions. Q: What does each assume about technology and food supply?
- Treats development as only GDP. Q: Which indicator would you add to show life expectancy or education, and what does a composite hide?
- Describes globalisation as a single effect (always good or always bad). Q: Which places gain and which lose, and why?
- Assumes tourism is automatically sustainable (ecotourism). Q: What carrying capacity or leakage of income could undermine it?
- Misuses "fair trade" or "aid" without distinguishing top-down and bottom-up approaches. Q: Who decides how the aid is used?
- Fieldwork: the question is too broad, sample is biased or too small, a statistical test is chosen without matching the data. Q: How many sites or respondents, how chosen, and why that test?
- Evaluation of fieldwork only says "more time next time". Q: Which specific limitation affects the validity of your conclusion most, and how?
- Confuses precision and accuracy and reliability of data. Q: If I repeated your survey, would I get the same answer, and is that the same as being right?
- Answer drifts to the topic not the command term (describes when asked to evaluate). Q: What is the verb in the question and what must your last paragraph do?

5. QUESTION TYPES AND EXAM TECHNIQUE
- Paper 2 data questions: read the infographic's source, title and scale first; answer with value, comparison, trend and, if asked, the reason. The extended response should have a plan: define, case study with figures, counter-view, evaluation.
- Paper 1: for each option answer the short parts in a line or two per mark; the extended response is a mini-essay with named case studies and an evaluation. Timing about one minute per mark.
- Paper 3 (HL): conceptual essay linking power, development and risk; use contrasting places (for example high-income and low-income) and say how power or networks cause the pattern.
- Case-study banks should be organised by theme with place, date, two facts, the stakeholders and an evaluation of the outcome. Maps and sketches may be annotated for marks.

6. CALIBRATION EXAMPLES (original; data fictional)
- Q1 [Paper 2, 4 marks]. A fictional table shows Country X's dependency ratio rising from 52 to 61 between 2000 and 2030 while its fertility rate falls from 3.1 to 1.9. (a) Calculate the percentage change in the dependency ratio (2 marks). (b) Suggest one reason it rises although fertility falls (2 marks). Answer: (61 - 52)/52 x 100 = 17.3 percent (about 17); reason: ageing population as life expectancy rises so the elderly group grows faster than the working group, even though the child group shrinks.
- Q2 [Paper 2 extended, 15 marks]. Evaluate the effectiveness of strategies to reduce the carbon footprint of a large urban area. Outline: define carbon footprint; two or three strategies with named example (transport, energy mix, planning, personal action); effectiveness by scale and cost; stakeholders and equity; political and economic obstacles; a judgement about which is most effective in the short and long run.
- Q3 [Paper 3, HL, 20-ish marks]. To what extent does globalisation increase inequality between places? Outline: define globalisation (flows of capital, goods, people, ideas); evidence for widening (core versus periphery, TNC profits, brain drain) and for narrowing (FDI-led growth, remittances); scale (between and within countries); a named contrasting pair; judgement conditional on state policy and place.

7. TUTOR MOVES
- Start with place: "Which actual place are you using, and what is one fact you know about it?" Make the student build a bank of 2-3 facts per case.
- For data, ask them to give the pattern, then an anomaly, then a number, then a reason.
- For evaluation, ask "who benefits, who loses, how soon, how big, what would improve it?" and have them rank.
- For HL synthesis, ask them to link two themes (climate and migration, or globalisation and the nexus) and explain the mechanism.
- For fieldwork, question the logic: question, hypothesis, method, data, test, conclusion, limitation. Never supply data or write text.` },
];

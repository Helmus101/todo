// Prerequisite maps for the IB subjects beyond Mathematics (see shared/ibMathsGraph.ts for the pattern): each node is one assessable idea and
// `needs` lists the ideas it rests on, so the tutor can check what a weak idea builds on before teaching on top of it. A teaching aid, not the
// syllabus (the subject pack and the official guide are the syllabus); HL-only nodes are marked.
import { MATHS_AA_GRAPH, type MathsNode } from "./ibMathsGraph.ts";

export type IbNode = MathsNode;

const PHYSICS: IbNode[] = [
  { id: "units", title: "units, vectors and uncertainties", needs: [], match: /\bunits?\b|vector|scalar|uncertaint|significant figures/i },
  { id: "kinematics", title: "kinematics and projectile motion", needs: ["units"], match: /kinematic|projectile|suvat|velocity|acceleration|displacement/i },
  { id: "forces", title: "forces and Newton's laws", needs: ["kinematics"], match: /newton|force|free.?body|friction|equilibrium of forces/i },
  { id: "momentum", title: "momentum and impulse", needs: ["forces"], match: /momentum|impulse|collision/i },
  { id: "energy", title: "work, energy and power", needs: ["forces", "kinematics"], match: /work done|kinetic energy|potential energy|\bpower\b|efficiency|energy conservation/i },
  { id: "circular", title: "circular motion", needs: ["forces", "kinematics"], match: /circular motion|centripetal/i },
  { id: "thermal", title: "thermal energy and heat transfer", needs: ["energy"], match: /thermal|specific heat|latent heat|conduction|convection|greenhouse/i },
  { id: "gas", title: "ideal gases", needs: ["thermal"], match: /ideal gas|gas law|pressure and volume|kinetic model/i },
  { id: "thermodynamics", title: "thermodynamics (first law, entropy, cycles)", needs: ["gas", "energy"], hl: true, match: /thermodynamic|first law|entropy|carnot|isothermal|adiabatic/i },
  { id: "circuits", title: "current, potential difference and circuits", needs: ["units"], match: /circuit|resistance|resistor|current|potential difference|emf|internal resistance/i },
  { id: "shm", title: "simple harmonic motion", needs: ["forces", "energy", "kinematics"], match: /simple harmonic|\bshm\b|oscillat|pendulum|spring/i },
  { id: "waves", title: "the wave model", needs: ["kinematics"], match: /wave speed|wavelength|frequency|transverse|longitudinal|wave model/i },
  { id: "wave-phenomena", title: "reflection, refraction, diffraction and interference", needs: ["waves"], match: /refraction|diffraction|interference|snell|double slit|polari[sz]/i },
  { id: "standing-waves", title: "standing waves and resonance", needs: ["wave-phenomena"], match: /standing wave|resonance|harmonic|node/i },
  { id: "doppler", title: "the Doppler effect", needs: ["waves"], match: /doppler/i },
  { id: "gravitation", title: "gravitational fields", needs: ["forces", "circular"], match: /gravitation|orbit|kepler|field strength/i },
  { id: "em-fields", title: "electric and magnetic fields", needs: ["forces", "circuits"], match: /electric field|magnetic field|coulomb|charge|lorentz|capacit/i },
  { id: "induction", title: "electromagnetic induction", needs: ["em-fields"], hl: true, match: /induction|faraday|lenz|generator|transformer/i },
  { id: "atom", title: "atomic structure and spectra", needs: ["energy", "em-fields"], match: /atomic|emission spectr|energy level|nuclear model|nucleus/i },
  { id: "quantum", title: "quantum physics", needs: ["atom", "waves"], hl: true, match: /photoelectric|photon|de broglie|quantum|wave.?particle|uncertainty principle/i },
  { id: "decay", title: "radioactive decay", needs: ["atom"], match: /radioactiv|half.?life|decay|activity|alpha|beta|gamma/i },
  { id: "fission-fusion", title: "fission, fusion and stars", needs: ["decay", "energy"], match: /fission|fusion|binding energy|stellar|hr diagram|stars?\b/i },
  { id: "relativity", title: "special relativity", needs: ["kinematics"], hl: true, match: /relativity|lorentz factor|time dilation|length contraction|spacetime/i },
];

const CHEMISTRY: IbNode[] = [
  { id: "mole", title: "the mole and amounts of substance", needs: [], match: /\bmole\b|molar mass|avogadro|empirical formula|percentage yield/i },
  { id: "atom", title: "the nuclear atom and electron configuration", needs: [], match: /electron configuration|isotope|atomic structure|nuclear atom|relative atomic mass/i },
  { id: "periodicity", title: "periodic trends", needs: ["atom"], match: /periodic|ionisation energy|electronegativity|atomic radius|trend/i },
  { id: "bonding", title: "ionic, covalent and metallic bonding", needs: ["atom", "periodicity"], match: /ionic|covalent|metallic|lewis|vsepr|bond polarity|hybridi[sz]/i },
  { id: "imf", title: "intermolecular forces", needs: ["bonding"], match: /intermolecular|hydrogen bond|london|dispersion|dipole|boiling point/i },
  { id: "gases-solutions", title: "gases and solutions", needs: ["mole"], match: /ideal gas|molar volume|concentration|titration|dilution|mol dm/i },
  { id: "energetics", title: "enthalpy changes and Hess's law", needs: ["mole"], match: /enthalpy|hess|calorimet|bond enthalpies|exothermic|endothermic/i },
  { id: "entropy", title: "entropy and spontaneity", needs: ["energetics"], match: /entropy|gibbs|spontaneity|free energy/i },
  { id: "kinetics", title: "rates of reaction", needs: ["mole"], match: /rate of reaction|collision theory|activation energy|rate law|order of reaction|catalyst/i },
  { id: "equilibrium", title: "equilibrium and Le Chatelier", needs: ["kinetics", "mole"], match: /equilibrium|le chatelier|\bkc\b|\bkp\b|reaction quotient/i },
  { id: "acids-bases", title: "acids, bases and pH", needs: ["equilibrium"], match: /acid|base|\bph\b|\bpka\b|\bkw\b|buffer|neutralis/i },
  { id: "redox", title: "oxidation and reduction", needs: ["bonding", "mole"], match: /redox|oxidation|reduction|oxidising|reducing agent/i },
  { id: "electrochem", title: "electrochemical cells", needs: ["redox", "energetics"], match: /electrochem|voltaic|galvanic|electrolysis|standard electrode/i },
  { id: "organic-basics", title: "functional groups and nomenclature", needs: ["bonding", "imf"], match: /functional group|nomenclature|homologous|isomer|alkane|alkene|alcohol/i },
  { id: "organic-reactions", title: "organic reactions and mechanisms", needs: ["organic-basics", "kinetics"], match: /mechanism|nucleophil|electrophil|substitution|addition reaction|elimination|esterification/i },
];

const BIOLOGY: IbNode[] = [
  { id: "cells", title: "cell structure", needs: [], match: /cell structure|organelle|prokaryot|eukaryot|microscop|magnification/i },
  { id: "biomolecules", title: "water and the molecules of life", needs: [], match: /water|carbohydrate|lipid|protein|nucleic acid|amino acid/i },
  { id: "membranes", title: "membranes and transport", needs: ["biomolecules", "cells"], match: /membrane|osmosis|diffusion|active transport|water potential/i },
  { id: "enzymes", title: "enzymes and metabolism", needs: ["biomolecules"], match: /enzyme|substrate|active site|inhibit|denatur/i },
  { id: "respiration", title: "cell respiration", needs: ["enzymes", "membranes"], match: /respiration|atp|glycolysis|krebs|electron transport|anaerobic/i },
  { id: "photosynthesis", title: "photosynthesis", needs: ["enzymes", "membranes"], match: /photosynthes|chlorophyll|light.?dependent|calvin/i },
  { id: "dna", title: "DNA structure and replication", needs: ["biomolecules"], match: /dna|replication|nucleotide|helicase|polymerase/i },
  { id: "protein-synthesis", title: "transcription and translation", needs: ["dna"], match: /transcription|translation|mrna|trna|codon|ribosome|genetic code/i },
  { id: "division", title: "mitosis and meiosis", needs: ["dna", "cells"], match: /mitosis|meiosis|cell cycle|chromosome/i },
  { id: "inheritance", title: "inheritance and genetics", needs: ["division"], match: /inherit|allele|punnett|genotype|phenotype|dihybrid|linkage|pedigree/i },
  { id: "gene-expression", title: "gene expression and regulation", needs: ["protein-synthesis"], hl: true, match: /gene expression|epigenetic|operon|promoter|regulat/i },
  { id: "evolution", title: "evolution and natural selection", needs: ["inheritance"], match: /evolution|natural selection|speciation|adaptation|cladistic|phylogen/i },
  { id: "ecology", title: "ecosystems and energy flow", needs: ["photosynthesis", "respiration"], match: /ecosystem|food chain|trophic|energy flow|nutrient cycl|population|biodiversity|simpson/i },
  { id: "body-systems", title: "transport, signalling and body systems", needs: ["membranes"], match: /neuron|nerve|hormone|circulat|heart|gas exchange|kidney|muscle/i },
  { id: "defence", title: "defence against disease", needs: ["cells"], match: /immun|antibod|pathogen|vaccin|antigen|infect/i },
];

const ECONOMICS: IbNode[] = [
  { id: "supply-demand", title: "demand, supply and market equilibrium", needs: [], match: /demand|supply|equilibrium price|surplus|shortage|consumer surplus|producer surplus/i },
  { id: "elasticity", title: "elasticities", needs: ["supply-demand"], match: /elastic|\bped\b|\bpes\b|\byed\b|\bxed\b/i },
  { id: "market-failure", title: "externalities and market failure", needs: ["supply-demand"], match: /externalit|market failure|public good|merit good|demerit|common pool/i },
  { id: "intervention", title: "government intervention in markets", needs: ["market-failure", "elasticity"], match: /indirect tax|subsid|price ceiling|price floor|minimum price|maximum price|regulation|tradable permit/i },
  { id: "costs", title: "costs, revenues and profit", needs: ["supply-demand"], match: /cost|revenue|profit|marginal|economies of scale|production function/i },
  { id: "market-structures", title: "market structures", needs: ["costs"], match: /monopol|oligopol|perfect competition|market structure|game theory/i },
  { id: "circular-flow", title: "the circular flow and national income", needs: [], match: /circular flow|gdp|national income|injection|leakage/i },
  { id: "ad-as", title: "aggregate demand and supply", needs: ["circular-flow"], match: /aggregate demand|aggregate supply|\bad\b.*\bas\b|keynesian|monetarist|multiplier/i },
  { id: "macro-objectives", title: "inflation, unemployment and growth", needs: ["ad-as"], match: /inflation|unemployment|economic growth|equity|income distribution/i },
  { id: "policy", title: "fiscal, monetary and supply-side policy", needs: ["macro-objectives"], match: /fiscal|monetary|supply.?side|interest rate|central bank|budget/i },
  { id: "trade", title: "international trade", needs: ["supply-demand"], match: /trade|tariff|quota|comparative advantage|protection|wto/i },
  { id: "exchange-rates", title: "exchange rates and the balance of payments", needs: ["trade"], match: /exchange rate|balance of payments|current account|depreciation|appreciation/i },
  { id: "development", title: "economic development", needs: ["macro-objectives", "trade"], match: /development|poverty|hdi|gini|foreign aid|sustainab/i },
];

const GRAPHS: { test: RegExp; nodes: IbNode[] }[] = [
  { test: /\bphysics\b|\bphysique\b/i, nodes: PHYSICS },
  { test: /chem|chimie/i, nodes: CHEMISTRY },
  { test: /\bbio/i, nodes: BIOLOGY },
  { test: /econ/i, nodes: ECONOMICS },
  { test: /\bmath|\baa\b|\bai\b|^$/i, nodes: MATHS_AA_GRAPH },
];

/** The map for a subject ("Physics HL", "Biology"), or none. A concept with no subject is looked up in the maths map, as before. */
export function graphFor(subject?: string): IbNode[] {
  const s = String(subject || "").trim();
  return GRAPHS.find((g) => g.test.test(s))?.nodes || [];
}

export function ibNodeFor(label: string, subject?: string): IbNode | undefined {
  const l = String(label || "");
  return graphFor(subject).find((n) => n.match.test(l));
}

/** The ideas a concept builds on, directly (one level). */
export function ibPrerequisites(label: string, subject?: string): IbNode[] {
  const nodes = graphFor(subject);
  const n = nodes.find((x) => x.match.test(String(label || "")));
  if (!n) return [];
  const byId = new Map(nodes.map((x) => [x.id, x]));
  return n.needs.map((id) => byId.get(id)!).filter(Boolean);
}

export const IB_GRAPHS = { physics: PHYSICS, chemistry: CHEMISTRY, biology: BIOLOGY, economics: ECONOMICS };

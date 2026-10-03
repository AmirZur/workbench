import type { AlgorithmDefinition, AlgorithmHypothesisMode } from "@/types/algorithmHypothesis";
import { EXAMPLE_PROMPTS } from "@/lib/algorithmHypothesis/grids";
import type { ExampleKind } from "@/lib/algorithmHypothesis/presets";
import type { InterventionState } from "./InterventionView";
import type { SweepState } from "./SweepView";
import type { WalkthroughStep } from "./Walkthrough";

/**
 * The paper demo (P6): a walkthrough of Gur-Arieh, Geva & Geiger (2025) on
 * gemma-2-2b-it with the Figure 1 inputs. Each step can be done by hand or
 * with its button; a step is checked once its state is in place.
 */

export const WALKTHROUGH_MODEL = "google/gemma-2-2b-it";
const TARGET = EXAMPLE_PROMPTS[0].text; // … What does Tim love?
const SOURCE = EXAMPLE_PROMPTS[1].text; // … What does Ann love?
const SOURCE_COD = EXAMPLE_PROMPTS[2].text; // Ann loves cod, which the target never mentions

interface PaperWalkthroughContext {
    definition: AlgorithmDefinition;
    prompt: string;
    tokens: string[];
    tokensLoading: boolean;
    mode: AlgorithmHypothesisMode;
    versionState: "draft" | "saved" | "changed";
    problemCount: number;
    intervention: InterventionState | null;
    sweep: SweepState | null;
    start: () => void;
    loadExample: (kind: ExampleKind) => void;
    save: () => void;
    intervene: (state: InterventionState) => void;
    sweepWith: (state: SweepState) => void;
}

const Mono = ({ children }: { children: React.ReactNode }) => (
    <span className="font-mono text-xs">{children}</span>
);

export function paperWalkthroughSteps(c: PaperWalkthroughContext): WalkthroughStep[] {
    const onGemma =
        c.definition.grid.kind === "model" && c.definition.grid.model === WALKTHROUGH_MODEL;
    const ready = onGemma && c.prompt === TARGET && !c.tokensLoading && c.tokens.length > 0;
    const hasPositional =
        c.definition.variables.some((v) => v.id === "q_pos") &&
        c.definition.variables.some((v) => v.id === "id1");
    const last = c.tokens.length - 1;
    const layerOf = (id: string, fallback: number) =>
        c.definition.variables.find((v) => v.id === id)?.cell.layer ?? fallback;
    // gemma-2-2b-it's binding window in the paper is L16–18; the example puts P at L16.
    const windowLayer = layerOf("P", 16);
    // Where the answer is computed (on 26 layers an `output` copy sits above it).
    const answerLayer = layerOf("answer", 19);
    const spec = c.intervention?.spec;
    const at = (layer: number) => ({
        sourceLayer: layer,
        sourceToken: last,
        targetLayer: layer,
        targetToken: last,
    });
    const intervenedAt = (layer: number, source: string) =>
        c.mode === "intervene" &&
        c.intervention?.source === source &&
        c.intervention.target === TARGET &&
        spec?.targetLayer === layer &&
        spec.sourceLayer === layer &&
        spec.targetToken === last &&
        spec.sourceToken === last;
    const needs = (ok: boolean, msg: string) => (ok ? undefined : msg);

    return [
        {
            id: "start",
            title: "The task, on gemma-2-2b-it",
            body: (
                <>
                    <p>
                        Gur-Arieh, Geva &amp; Geiger (2025) ask how a model answers{" "}
                        <em>What does Tim love?</em> after reading “Ann loves ale, Joe loves jam,
                        Pete loves pie, Tim loves tea”. They describe three algorithms:
                    </p>
                    <ul className="list-disc pl-5">
                        <li>
                            <b>Positional</b>: retrieve the entity at the recalled name&apos;s
                            position.
                        </li>
                        <li>
                            <b>Lexical</b>: retrieve the entity bound to the name itself.
                        </li>
                        <li>
                            <b>Reflexive</b>: follow a pointer to the entity token.
                        </li>
                    </ul>
                    <p>
                        This walkthrough builds them on gemma-2-2b-it&apos;s 26 layers and tokens
                        and finds an intervention where they disagree. It starts a new algorithm, so
                        yours stay as they are. Nothing runs the model: only its tokenizer.
                    </p>
                </>
            ),
            action: { label: "Start on gemma-2-2b-it", run: c.start },
            done: onGemma && c.prompt === TARGET,
        },
        {
            id: "positional",
            title: "The positional algorithm",
            body: (
                <>
                    <p>
                        The names are the algorithm&apos;s <b>special tokens</b> (underlined).
                        Position ID numbers them in order of first appearance and stores a position
                        ID : name pair: <Mono>pos1 = 1:Ann</Mono>. Each ID is copied onto the bound
                        entity (<Mono>id1</Mono>) and bound to it (<Mono>bind1 = 1:ale</Mono>).
                    </p>
                    <p>
                        When the question recalls Tim, Position ID gives the second Tim its first
                        mention&apos;s ID, <Mono>q_pos = 4:Tim</Mono>. The last token carries the ID
                        (<Mono>P = 4</Mono>) and retrieves the entity bound to it: tea.
                    </p>
                    <p>Click q_pos in the grid to see Position ID&apos;s code.</p>
                </>
            ),
            action: {
                label: "Load the positional algorithm",
                run: () => c.loadExample("positional"),
                disabled: needs(ready, "Do step 1 first; gemma-2-2b-it's tokens load then."),
            },
            done: onGemma && hasPositional,
        },
        {
            id: "save",
            title: "Save it",
            body: (
                <>
                    <p>
                        Edits are kept as a draft automatically. <b>Save</b> marks an algorithm as
                        complete, and saved algorithms appear next to each other when you intervene
                        or sweep.
                    </p>
                    <p>
                        The paper&apos;s lexical and reflexive algorithms and their mixture appear
                        there too, as examples, so the next steps can compare all of them.
                    </p>
                </>
            ),
            action: {
                label: "Save",
                run: c.save,
                disabled: needs(
                    hasPositional && !c.problemCount,
                    "Load the positional algorithm first.",
                ),
            },
            done: hasPositional && c.versionState === "saved",
        },
        {
            id: "intervene",
            title: `Intervene at the last token, L${windowLayer}`,
            body: (
                <>
                    <p>
                        The <b>source</b> asks about Ann (“Joe loves ale, Ann loves pie, …”); the{" "}
                        <b>target</b> asks about Tim. Swapping the last token&apos;s cell at L
                        {windowLayer} from the source into the target gives each algorithm a
                        different <b>counterfactual</b> output:
                    </p>
                    <ul className="list-disc pl-5">
                        <li>
                            Positional: Ann is the source&apos;s 2nd name, so P = 2 retrieves the
                            target&apos;s 2nd entity, <b>jam</b>.
                        </li>
                        <li>
                            Lexical: L = Ann retrieves Ann&apos;s entity in the target, <b>ale</b>.
                        </li>
                        <li>
                            Reflexive: R points to pie, which the target has, so <b>pie</b>.
                        </li>
                    </ul>
                    <p>
                        The Mixed example combines the three (the paper&apos;s Eq. 2) with
                        illustrative weights, not the paper&apos;s fitted ones.
                    </p>
                </>
            ),
            action: {
                label: `Intervene at L${windowLayer}`,
                run: () => c.intervene({ source: SOURCE, target: TARGET, spec: at(windowLayer) }),
                disabled: needs(hasPositional && last >= 0, "Load the positional algorithm first."),
            },
            done: hasPositional && intervenedAt(windowLayer, SOURCE),
        },
        {
            id: "answer",
            title: `Swap the answer itself, L${answerLayer}`,
            body: (
                <p>
                    At L{answerLayer} the last token already holds the answer, so the intervention
                    swaps in the source&apos;s answer, <b>pie</b>, and every algorithm agrees. The
                    paper points out this confound: the reflexive prediction is also the
                    source&apos;s answer, so the binding window has to come before it.
                </p>
            ),
            action: {
                label: `Intervene at L${answerLayer}`,
                run: () => c.intervene({ source: SOURCE, target: TARGET, spec: at(answerLayer) }),
                disabled: needs(hasPositional && last >= 0, "Load the positional algorithm first."),
            },
            done: hasPositional && intervenedAt(answerLayer, SOURCE),
        },
        {
            id: "cod",
            title: "Pointer or answer? A source with cod",
            body: (
                <p>
                    To tell the reflexive pointer from the answer, the paper uses a source where Ann
                    loves <b>cod</b>, which the target never mentions. At L{windowLayer} the
                    reflexive algorithm finds nothing to dereference and outputs <b>∅</b>; the
                    positional and lexical predictions don&apos;t change. Move the intervention to L
                    {answerLayer} and every algorithm outputs cod.
                </p>
            ),
            action: {
                label: "Use the cod source",
                run: () =>
                    c.intervene({ source: SOURCE_COD, target: TARGET, spec: at(windowLayer) }),
                disabled: needs(hasPositional && last >= 0, "Load the positional algorithm first."),
            },
            done: hasPositional && c.mode === "intervene" && c.intervention?.source === SOURCE_COD,
        },
        {
            id: "sweep",
            title: "Sweep the last token",
            body: (
                <p>
                    A sweep runs the intervention at every layer, from the embedding row up. The
                    algorithms disagree in the <b>binding window</b>, L{windowLayer}–L
                    {answerLayer - 1}, where P, L and R sit at the last token; that matches the
                    paper&apos;s Figure 2, where gemma-2-2b-it&apos;s window is L16–18. From L
                    {answerLayer} on, the answer itself is swapped.
                </p>
            ),
            action: {
                label: "Sweep the last token",
                run: () =>
                    c.sweepWith({ source: SOURCE, target: TARGET, token: last, full: false }),
                disabled: needs(hasPositional && last >= 0, "Load the positional algorithm first."),
            },
            done:
                hasPositional &&
                c.mode === "sweep" &&
                c.sweep?.token === last &&
                c.sweep.source === SOURCE &&
                c.sweep.target === TARGET,
        },
        {
            id: "yours",
            title: "Your turn",
            body: (
                <>
                    <p>Some hypotheses to try:</p>
                    <ul className="list-disc pl-5">
                        <li>
                            Load the Mixed example (Edit, Algorithm panel) and open{" "}
                            <Mono>answer</Mono> to change w_pos, σ, w_lex and w_ref; save it under a
                            new name and compare.
                        </li>
                        <li>
                            Move P earlier or later and sweep again: the window follows P&apos;s
                            span.
                        </li>
                        <li>
                            Swap a name token on the embedding row (Intervene, token labels): every
                            algorithm then answers about the other name.
                        </li>
                        <li>
                            Write a custom Python function, save, and compare it with the
                            paper&apos;s.
                        </li>
                    </ul>
                </>
            ),
            done: false,
        },
    ];
}

export const WALKTHROUGH_TARGET = TARGET;

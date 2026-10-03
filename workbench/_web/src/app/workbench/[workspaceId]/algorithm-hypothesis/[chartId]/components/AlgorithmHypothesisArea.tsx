"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { getChartById, setChartData } from "@/lib/queries/chartQueries";
import { updateAlgorithm } from "@/lib/queries/algorithmQueries";
import {
    useAlgorithm,
    useCreateAlgorithm,
    useSaveAlgorithmVersion,
    useModelTokens,
    useSaveAlgorithm,
    useWorkspaceAlgorithms,
} from "@/lib/api/algorithmApi";
import { queryKeys } from "@/lib/queryKeys";
import { useCapture } from "@/lib/analytics";
import type {
    AlgorithmDefinition,
    AlgorithmHypothesisChartData,
    AlgorithmHypothesisMode,
    AlgorithmView,
    Cell,
    Ref,
    Variable,
} from "@/types/algorithmHypothesis";
import {
    evaluate,
    inferTypes,
    moveProblem,
    outputOf,
    problems as algorithmProblems,
    removeVariable,
    sameDefinition,
    upgradeDefinition,
    withInferredTypes,
    withSpecialTokens,
} from "@/lib/algorithmHypothesis/engine";
import { show } from "@/lib/algorithmHypothesis/primitives";
import { pythonResolver, retryPython, usePythonRuntime } from "@/lib/algorithmHypothesis/python";
import { entityBindingExample, type ExampleKind } from "@/lib/algorithmHypothesis/presets";
import {
    DEFAULT_PROMPT,
    DEFAULT_VIEW,
    GRID_OPTIONS,
    blankAlgorithm,
    gridLabel,
    gridOptionId,
    tokenizeAbstract,
} from "@/lib/algorithmHypothesis/grids";
import { AlgorithmGrid } from "./AlgorithmGrid";
import { AlgorithmPanel, type SaveState } from "./AlgorithmPanel";
import { GridToolbar } from "./GridToolbar";
import InterventionView, {
    defaultInterventionState,
    type InterventionState,
} from "./InterventionView";
import SweepView, { defaultSweepState, type SweepState } from "./SweepView";
import { Walkthrough } from "./Walkthrough";
import { WALKTHROUGH_MODEL, WALKTHROUGH_TARGET, paperWalkthroughSteps } from "./paperWalkthrough";
import { VariablePanel } from "./VariablePanel";
import {
    addRef,
    applyDraft,
    draftFromVariable,
    draftProblems,
    draftTypes,
    newDraft,
    pasteDraft,
    refKeys,
    refTyper,
    refreshSpecials,
    type VariableDraft,
} from "./draft";

const SAVE_DEBOUNCE_MS = 500;
const CHART_AUTOSAVE_MS = 600;

/**
 * Container for Algorithm Hypothesis: reads the route, loads the chart and its
 * algorithm, keeps a working copy of the algorithm that autosaves, and routes
 * grid clicks to editing, picking arguments or focusing tokens. In "intervene"
 * mode it hands the algorithm to InterventionView.
 */
export default function AlgorithmHypothesisArea({ mobile = false }: { mobile?: boolean }) {
    const { chartId, workspaceId } = useParams<{ chartId: string; workspaceId: string }>();
    const queryClient = useQueryClient();
    const capture = useCapture();

    const openedChart = useRef<string | null>(null);
    useEffect(() => {
        if (!chartId || openedChart.current === chartId) return;
        openedChart.current = chartId;
        capture("tool_opened", { tool: "algorithm-hypothesis" });
    }, [chartId, capture]);

    const { data: chart, isLoading: chartLoading } = useQuery({
        queryKey: queryKeys.charts.chart(chartId),
        queryFn: () => getChartById(chartId),
        enabled: !!chartId,
    });
    const chartData = (chart?.data ?? null) as AlgorithmHypothesisChartData | null;
    const algorithmId = chartData?.algorithmId;
    const { data: algorithmRow, isLoading: algorithmLoading } = useAlgorithm(algorithmId);
    const { data: algorithmList } = useWorkspaceAlgorithms(workspaceId);
    const { mutateAsync: createAlgorithm } = useCreateAlgorithm();

    // ------------------------------------------- prompt and view (chart row)

    const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
    const [view, setView] = useState<AlgorithmView>(DEFAULT_VIEW);
    const [mode, setMode] = useState<AlgorithmHypothesisMode>("edit");
    const [intervention, setIntervention] = useState<InterventionState | null>(null);
    const [sweep, setSweep] = useState<SweepState | null>(null);
    const [walkthrough, setWalkthrough] = useState<{
        open: boolean;
        step: number;
        done?: string[];
    } | null>(null);
    const hydratedChart = useRef<string | null>(null);
    useEffect(() => {
        if (!chart || hydratedChart.current === chart.id) return;
        const d = chart.data as AlgorithmHypothesisChartData | null;
        if (typeof d?.prompt === "string") setPrompt(d.prompt);
        setView({ ...DEFAULT_VIEW, ...(d?.view ?? {}) });
        setMode(d?.mode === "intervene" || d?.mode === "sweep" ? d.mode : "edit");
        setIntervention(d?.intervention ?? null);
        setSweep(d?.sweep ?? null);
        setWalkthrough(d?.walkthrough ?? null);
        hydratedChart.current = chart.id;
    }, [chart]);

    const writeChartData = useCallback(
        async (next: AlgorithmHypothesisChartData) => {
            await setChartData(chartId, next, "algorithm-hypothesis");
            queryClient.setQueryData(
                queryKeys.charts.chart(chartId),
                (prev: Awaited<ReturnType<typeof getChartById>> | undefined) =>
                    prev ? { ...prev, data: next } : prev,
            );
        },
        [chartId, queryClient],
    );

    const chartState = useCallback(
        (id: string): AlgorithmHypothesisChartData => ({
            algorithmId: id,
            prompt,
            view,
            mode,
            ...(intervention ? { intervention } : {}),
            ...(sweep ? { sweep } : {}),
            ...(walkthrough ? { walkthrough } : {}),
        }),
        [prompt, view, mode, intervention, sweep, walkthrough],
    );

    useEffect(() => {
        if (hydratedChart.current !== chartId || !algorithmId) return;
        const next = chartState(algorithmId);
        if (JSON.stringify(next) === JSON.stringify(chartData)) return;
        const handle = setTimeout(() => void writeChartData(next), CHART_AUTOSAVE_MS);
        return () => clearTimeout(handle);
    }, [chartState, algorithmId, chartId, chartData, writeChartData]);

    // -------------------------------- the algorithm (working copy, autosaved)

    const [definition, setDefinition] = useState<AlgorithmDefinition | null>(null);
    // The version saved as complete; other algorithms compare against saved versions.
    const [savedDefinition, setSavedDefinition] = useState<AlgorithmDefinition | null>(null);
    const [draft, setDraft] = useState<VariableDraft | null>(null);
    const hydratedAlgorithm = useRef<string | null>(null);
    useEffect(() => {
        if (!algorithmRow || hydratedAlgorithm.current === algorithmRow.id) return;
        setDefinition(upgradeDefinition(algorithmRow.definition));
        setSavedDefinition(
            algorithmRow.savedDefinition ? upgradeDefinition(algorithmRow.savedDefinition) : null,
        );
        setDraft(null);
        hydratedAlgorithm.current = algorithmRow.id;
    }, [algorithmRow]);

    const { mutate: saveAlgorithm } = useSaveAlgorithm();
    const [saveState, setSaveState] = useState<SaveState>("saved");
    const pending = useRef<{ id: string; definition: AlgorithmDefinition } | null>(null);
    const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    const flush = useCallback(() => {
        clearTimeout(saveTimer.current);
        const job = pending.current;
        pending.current = null;
        if (!job) return;
        saveAlgorithm(job, {
            onSuccess: () => setSaveState(pending.current ? "saving" : "saved"),
            onError: () => setSaveState("error"),
        });
    }, [saveAlgorithm]);

    const commit = useCallback(
        (next: AlgorithmDefinition) => {
            const id = hydratedAlgorithm.current;
            if (!id) return;
            // Position IDs read the special tokens, and primitives' stored types
            // follow their arguments, so both are refreshed on every edit.
            next = withInferredTypes(withSpecialTokens(next));
            setDefinition(next);
            pending.current = { id, definition: next };
            setSaveState("saving");
            clearTimeout(saveTimer.current);
            saveTimer.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
        },
        [flush],
    );

    // Don't lose an edit made just before navigating away.
    useEffect(
        () => () => {
            const job = pending.current;
            if (job) void updateAlgorithm(job.id, job.definition);
        },
        [],
    );

    // ------------------------------------------------------------- tokens

    const modelName = definition?.grid.kind === "model" ? definition.grid.model : undefined;
    const template = definition?.template ?? prompt;
    const promptTokensQuery = useModelTokens(modelName, prompt);
    const templateTokensQuery = useModelTokens(modelName, template);
    const tokens = useMemo(
        () => (modelName ? (promptTokensQuery.data ?? []) : tokenizeAbstract(prompt)),
        [modelName, promptTokensQuery.data, prompt],
    );
    const templateTokens = useMemo(
        () => (modelName ? (templateTokensQuery.data ?? tokens) : tokenizeAbstract(template)),
        [modelName, templateTokensQuery.data, tokens, template],
    );
    const tokenError = modelName ? (promptTokensQuery.error ?? templateTokensQuery.error) : null;
    const tokensLoading = !!modelName && promptTokensQuery.isLoading;

    // A blank algorithm follows the prompt, so the first variable is placed on it.
    useEffect(() => {
        if (definition && !definition.variables.length && definition.template !== prompt)
            commit({ ...definition, template: prompt });
    }, [definition, prompt, commit]);

    // ---------------------------------------------------------- evaluation

    const shown = useMemo(
        () => (definition && draft ? applyDraft(definition, draft) : definition),
        [definition, draft],
    );
    // Custom Python functions run in a Pyodide worker; results re-render.
    const python = usePythonRuntime();
    const resolver = useMemo(() => pythonResolver(python.version), [python.version]);
    const evaluation = useMemo(
        () => (shown ? evaluate(shown, tokens, { templateTokens, python: resolver }) : null),
        [shown, tokens, templateTokens, resolver],
    );
    const hasPython = !!shown?.variables.some((v) => v.function.kind === "python");
    const problems = useMemo(
        () => (definition ? algorithmProblems(definition, tokens.length) : []),
        [definition, tokens.length],
    );
    const problemIds = useMemo(
        () => new Set(problems.map((p) => p.variableId).filter((x): x is string => !!x)),
        [problems],
    );
    const draftIssues = useMemo(
        () => (definition && draft ? draftProblems(definition, tokens, draft) : null),
        [definition, draft, tokens],
    );
    // Types of everything shown, the draft included.
    const shownTypes = useMemo(() => (shown ? inferTypes(shown).types : new Map()), [shown]);
    const savedTypes = useMemo(
        () => (definition ? inferTypes(definition).types : new Map()),
        [definition],
    );
    const draftTypeInfo = useMemo(
        () => (definition && draft ? draftTypes(definition, tokens, draft) : null),
        [definition, draft, tokens],
    );
    const typeOfRef = useMemo(
        () => (definition ? refTyper(definition, tokens).typeOf : () => null),
        [definition, tokens],
    );
    const specialSet = useMemo(
        () => new Set(definition?.specialTokens ?? []),
        [definition?.specialTokens],
    );
    const tagSuggestions = useMemo(
        () => [...new Set(definition?.variables.flatMap((v) => v.tags ?? []) ?? [])].sort(),
        [definition],
    );

    // -------------------------------------------------------------- editing

    const picking = !!draft && (!!draft.activeSlot || draft.function.kind === "python");
    // Clicking token labels marks the algorithm's special tokens.
    const [markingSpecials, setMarkingSpecials] = useState(false);

    /** Every draft change goes through here, so a Position ID's specials follow its cell. */
    const changeDraft = useCallback(
        (d: VariableDraft | null) => setDraft(d && definition ? refreshSpecials(definition, d) : d),
        [definition],
    );

    const pick = useCallback(
        (ref: Ref) => {
            if (!definition || !draft) return;
            setDraft(addRef(definition, tokens, draft, ref));
        },
        [definition, draft, tokens],
    );

    const toggleSpecial = useCallback(
        (token: number) => {
            if (!definition) return;
            const now = definition.specialTokens ?? [];
            commit(
                withSpecialTokens(
                    definition,
                    now.includes(token) ? now.filter((t) => t !== token) : [...now, token],
                ),
            );
        },
        [definition, commit],
    );

    const onCellClick = useCallback(
        (cell: Cell) => {
            if (!definition) return;
            if (draft) {
                if (draft.activeSlot) {
                    setDraft({
                        ...draft,
                        pickError:
                            "Click a token under the grid or a variable to add it as an argument.",
                    });
                    return;
                }
                // Not picking: clicking another cell moves the variable being edited.
                const layer =
                    draft.cell.token === cell.token && draft.cell.layer >= cell.layer
                        ? draft.cell.layer
                        : cell.layer;
                changeDraft({ ...draft, cell: { layer, token: cell.token }, pickError: null });
                return;
            }
            setDraft(newDraft(definition, cell, tokens.length));
        },
        [definition, draft, tokens.length, changeDraft],
    );

    const onTokenClick = useCallback(
        (token: number) => {
            if (markingSpecials) return toggleSpecial(token);
            if (picking) return pick({ token });
            setView((v) => {
                const focus = v.focus.includes(token)
                    ? v.focus.filter((t) => t !== token)
                    : [...v.focus, token].sort((a, b) => a - b);
                return { ...v, focus, collapse: focus.length ? v.collapse : false };
            });
        },
        [picking, pick, markingSpecials, toggleSpecial],
    );

    const onVariableClick = useCallback(
        (id: string) => {
            if (!definition) return;
            if (picking) return pick({ variable: id });
            if (draft?.id === id) return;
            const v = definition.variables.find((x) => x.id === id);
            if (v) setDraft(draftFromVariable(definition, v));
        },
        [definition, draft, picking, pick],
    );

    const gridMoveProblem = useCallback(
        (id: string, cell: Cell) => {
            if (!shown) return "Not ready.";
            // A moved Position ID reads the special tokens up to its new cell.
            const moved = withSpecialTokens({
                ...shown,
                variables: shown.variables.map((v) => (v.id === id ? { ...v, cell } : v)),
            }).variables.find((v) => v.id === id);
            const def = {
                ...shown,
                variables: shown.variables.map((v) =>
                    v.id === id && moved ? { ...moved, cell: v.cell } : v,
                ),
            };
            return moveProblem(def, id, cell, tokens.length);
        },
        [shown, tokens.length],
    );

    const onMove = useCallback(
        (id: string, cell: Cell) => {
            if (!definition) return;
            if (draft?.id === id) {
                changeDraft({ ...draft, cell });
                return;
            }
            commit({
                ...definition,
                variables: definition.variables.map((v) => (v.id === id ? { ...v, cell } : v)),
            });
            capture("param_changed", { tool: "algorithm-hypothesis", param: "variable_moved" });
        },
        [definition, draft, commit, capture, changeDraft],
    );

    // ----------------------------------------------------------- copy and paste

    const [clipboard, setClipboard] = useState<Variable | null>(null);

    const onCopyVariable = useCallback(() => {
        if (!definition || !draft || draft.isNew) return;
        const v = applyDraft(definition, draft).variables.find((x) => x.id === draft.id);
        if (!v) return;
        setClipboard(v);
        toast.success(`Copied ${v.name}. Click a cell, then Paste here; or Alt-drag a variable.`);
    }, [definition, draft]);

    const onPaste = useCallback(() => {
        if (!definition || !draft?.isNew || !clipboard) return;
        setDraft(pasteDraft(definition, clipboard, draft.cell));
    }, [definition, draft, clipboard]);

    /** Alt-drag: a copy of the variable as a new draft where it was dropped. */
    const onCopyTo = useCallback(
        (id: string, cell: Cell) => {
            if (!definition) return;
            const v = definition.variables.find((x) => x.id === id);
            if (!v) return;
            setClipboard(v);
            setDraft(pasteDraft(definition, v, cell));
            capture("param_changed", { tool: "algorithm-hypothesis", param: "variable_copied" });
        },
        [definition, capture],
    );

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
            const el = document.activeElement as HTMLElement | null;
            if (el?.closest("input, textarea, select, [contenteditable='true']")) return;
            if (window.getSelection()?.toString()) return;
            const key = e.key.toLowerCase();
            if (key === "c" && draft && !draft.isNew) {
                e.preventDefault();
                onCopyVariable();
            } else if (key === "v" && draft?.isNew && clipboard) {
                e.preventDefault();
                onPaste();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [draft, clipboard, onCopyVariable, onPaste]);

    const onSave = useCallback(() => {
        if (!definition || !draft || draftIssues?.blocking.length) return;
        commit(applyDraft(definition, { ...draft, name: draft.name.trim() }));
        setDraft(null);
    }, [definition, draft, draftIssues, commit]);

    const onDelete = useCallback(() => {
        if (!definition || !draft) return;
        commit(removeVariable(definition, draft.id));
        setDraft(null);
    }, [definition, draft, commit]);

    useEffect(() => {
        if (!draft && !markingSpecials) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            if (markingSpecials) return setMarkingSpecials(false);
            setDraft((d) => (d && d.activeSlot ? { ...d, activeSlot: null } : null));
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [draft, markingSpecials]);

    // ------------------------------------------------------ algorithm actions

    const onGridChange = (id: string) => {
        if (!definition) return;
        const option = GRID_OPTIONS.find((o) => o.id === id);
        if (!option) return;
        commit({ ...definition, grid: { ...option.grid } });
        setDraft(null);
        capture("param_changed", { tool: "algorithm-hypothesis", param: "grid", value: id });
    };

    const onSaveInput = (text: string) => {
        if (!definition || !text.trim() || definition.inputs?.includes(text)) return;
        commit({ ...definition, inputs: [...(definition.inputs ?? []), text] });
        toast.success("Saved the input with the algorithm.");
    };

    const onRemoveInput = (text: string) => {
        if (!definition) return;
        const before = definition;
        commit({ ...definition, inputs: (definition.inputs ?? []).filter((x) => x !== text) });
        toast("Removed the saved input.", {
            action: { label: "Undo", onClick: () => commit(before) },
        });
    };

    const onModeChange = (next: AlgorithmHypothesisMode) => {
        if (next === mode) return;
        setMode(next);
        if (next === "intervene" && !intervention)
            setIntervention(defaultInterventionState(prompt));
        if (next === "sweep" && !sweep) setSweep(defaultSweepState(prompt));
        capture("param_changed", { tool: "algorithm-hypothesis", param: "mode", value: next });
    };

    const onLoadExample = (kind: ExampleKind) => {
        if (!definition) return;
        const built = entityBindingExample(kind, tokens, definition.grid, prompt);
        if (typeof built === "string") {
            toast.error(built);
            return;
        }
        commit(built);
        setDraft(null);
        capture("param_changed", { tool: "algorithm-hypothesis", param: "example", value: kind });
    };

    const switchAlgorithm = async (id: string | "new" | "duplicate") => {
        if (!algorithmId || id === algorithmId) return;
        flush();
        try {
            let nextId = id;
            if (id === "new" || id === "duplicate") {
                const start =
                    id === "new" || !definition
                        ? {
                              ...blankAlgorithm(undefined, prompt),
                              grid: definition?.grid ?? blankAlgorithm().grid,
                          }
                        : { ...definition, name: `Copy of ${definition.name}` };
                nextId = (await createAlgorithm({ workspaceId, definition: start })).id;
            }
            setDraft(null);
            await writeChartData(chartState(nextId));
        } catch {
            toast.error("Couldn't open that algorithm.");
        }
    };

    // ------------------------------------------------- saving a complete version

    const { mutateAsync: saveVersion, isPending: savingVersion } = useSaveAlgorithmVersion();
    const versionState: "draft" | "saved" | "changed" = !savedDefinition
        ? "draft"
        : definition && sameDefinition(savedDefinition, definition)
          ? "saved"
          : "changed";

    const onSaveVersion = async () => {
        const id = hydratedAlgorithm.current;
        if (!definition || !id || problems.length) return;
        // The save writes the working copy too, so a pending autosave is moot.
        clearTimeout(saveTimer.current);
        pending.current = null;
        const row = await saveVersion({ id, definition });
        if (!row) return;
        setSavedDefinition(definition);
        setSaveState("saved");
        toast.success(
            `Saved “${definition.name}”. Intervene compares it with your other algorithms.`,
        );
        capture("param_changed", { tool: "algorithm-hypothesis", param: "algorithm_saved" });
    };

    const onRevert = () => {
        if (!savedDefinition) return;
        commit(savedDefinition);
        setDraft(null);
    };

    // ---------------------------------------------------------------- render

    // Loading, or loaded but not yet copied into the working state.
    if (chartLoading || algorithmLoading || (!!algorithmRow && !definition)) {
        return (
            <div className="m-3 h-48 flex-1 animate-pulse rounded bg-muted/50" aria-live="polite" />
        );
    }

    if (!definition || !evaluation || !shown || !algorithmId) {
        return (
            <div className="flex flex-1 flex-col items-start gap-3 rounded border bg-secondary/80 p-6 text-sm dark:bg-secondary/50">
                <p>This chart&apos;s algorithm couldn&apos;t be found. It may have been deleted.</p>
                <Button onClick={() => void switchAlgorithm("new")} disabled={!algorithmId}>
                    Start a new algorithm
                </Button>
            </div>
        );
    }

    const outputVar = definition.output
        ? definition.variables.find((v) => v.id === definition.output)
        : undefined;
    const offGrid = definition.variables.filter(
        (v) => v.cell.token >= tokens.length || v.cell.layer >= definition.grid.layers,
    );
    const lengthMismatch =
        !tokensLoading &&
        templateTokens.length !== tokens.length &&
        definition.variables.length > 0;

    // ------------------------------------------------------ paper walkthrough

    const toggleWalkthrough = () =>
        setWalkthrough((w) => ({ ...w, open: !w?.open, step: w?.step ?? 0 }));

    /** Step 1: a new algorithm on gemma-2-2b-it, so the user's own stay as they are. */
    const startWalkthrough = async () => {
        const grid = GRID_OPTIONS.find((o) => o.id === WALKTHROUGH_MODEL)?.grid;
        if (!grid) return;
        flush();
        try {
            const row = await createAlgorithm({
                workspaceId,
                definition: { ...blankAlgorithm("Paper walkthrough", WALKTHROUGH_TARGET), grid },
            });
            setDraft(null);
            setPrompt(WALKTHROUGH_TARGET);
            setMode("edit");
            const next = { open: true, step: 1 };
            setWalkthrough(next);
            await writeChartData({
                ...chartState(row.id),
                prompt: WALKTHROUGH_TARGET,
                mode: "edit",
                walkthrough: next,
            });
        } catch {
            toast.error("Couldn't start the walkthrough.");
        }
    };

    const walkthroughSteps = walkthrough?.open
        ? paperWalkthroughSteps({
              definition,
              prompt,
              tokens,
              tokensLoading,
              mode,
              versionState,
              problemCount: problems.length,
              intervention,
              sweep,
              start: () => void startWalkthrough(),
              loadExample: onLoadExample,
              save: () => void onSaveVersion(),
              intervene: (state) => {
                  setIntervention(state);
                  setMode("intervene");
              },
              sweepWith: (state) => {
                  setSweep(state);
                  setMode("sweep");
              },
          })
        : [];
    // A step stays checked once its state has been in place.
    const newlyDone = walkthroughSteps
        .filter((st) => st.done && !walkthrough?.done?.includes(st.id))
        .map((st) => st.id);
    if (walkthrough && newlyDone.length)
        queueMicrotask(() =>
            setWalkthrough((w) => (w ? { ...w, done: [...(w.done ?? []), ...newlyDone] } : w)),
        );
    const walkthroughPanel = walkthrough?.open ? (
        <Walkthrough
            title="Paper walkthrough"
            steps={walkthroughSteps.map((st) => ({
                ...st,
                done: st.done || !!walkthrough.done?.includes(st.id),
            }))}
            index={walkthrough.step}
            onIndexChange={(step) => setWalkthrough({ ...walkthrough, open: true, step })}
            onClose={() => setWalkthrough({ ...walkthrough, open: false })}
        />
    ) : null;

    /** The mode's view, with the walkthrough docked beside it when it's open. */
    const dock = (content: ReactNode) => {
        if (!walkthroughPanel) return content;
        if (mobile)
            return (
                <div className="flex flex-col gap-2">
                    {content}
                    <div className="rounded border bg-secondary/80 dark:bg-secondary/50">
                        {walkthroughPanel}
                    </div>
                </div>
            );
        return (
            <div className="flex h-full min-w-0 flex-1 gap-2">
                {content}
                <aside
                    aria-label="Paper walkthrough"
                    className="w-80 shrink-0 rounded border bg-secondary/80 dark:bg-secondary/50"
                >
                    {walkthroughPanel}
                </aside>
            </div>
        );
    };

    if (mode === "intervene" && intervention)
        return dock(
            <InterventionView
                workspaceId={workspaceId}
                algorithmId={algorithmId}
                definition={definition}
                savedDefinition={savedDefinition}
                types={savedTypes}
                view={view}
                templateTokens={templateTokens}
                state={intervention}
                onStateChange={setIntervention}
                onSaveInput={onSaveInput}
                onModeChange={onModeChange}
                walkthroughOpen={!!walkthrough?.open}
                onWalkthrough={toggleWalkthrough}
                mobile={mobile}
            />,
        );

    if (mode === "sweep" && sweep)
        return dock(
            <SweepView
                workspaceId={workspaceId}
                algorithmId={algorithmId}
                definition={definition}
                savedDefinition={savedDefinition}
                templateTokens={templateTokens}
                state={sweep}
                onStateChange={setSweep}
                onSaveInput={onSaveInput}
                onModeChange={onModeChange}
                walkthroughOpen={!!walkthrough?.open}
                onWalkthrough={toggleWalkthrough}
                mobile={mobile}
            />,
        );

    const gridPanel = (
        <div className="flex h-full min-h-0 flex-col">
            <GridToolbar
                mode={mode}
                onModeChange={onModeChange}
                walkthroughOpen={!!walkthrough?.open}
                onWalkthrough={toggleWalkthrough}
                prompt={prompt}
                onPromptChange={setPrompt}
                savedInputs={definition.inputs ?? []}
                onSaveInput={onSaveInput}
                gridId={gridOptionId(definition.grid)}
                onGridChange={onGridChange}
                view={view}
                onViewChange={(v) => setView((prev) => ({ ...prev, ...v }))}
            />
            {tokenError && (
                <p className="border-b px-4 py-2 text-xs text-destructive" role="alert">
                    Couldn&apos;t load the tokenizer for {modelName}, or an ungated copy of it. The
                    tokenizer downloads from Hugging Face, so check the network; a gated model also
                    works with HF_TOKEN in the repo-root .env (restart the dev server).
                </p>
            )}
            {lengthMismatch && (
                <p className="border-b px-4 py-2 text-xs text-amber-700 dark:text-amber-400">
                    This prompt has {tokens.length} tokens but the template has{" "}
                    {templateTokens.length}. Variables are anchored by token position, so check that
                    they sit on the right tokens and drag any that don&apos;t.
                </p>
            )}
            {offGrid.length > 0 && (
                <p className="border-b px-4 py-2 text-xs text-amber-700 dark:text-amber-400">
                    Off the grid: {offGrid.map((v) => v.name).join(", ")}. Open them from the
                    Algorithm panel to move them.
                </p>
            )}
            <div className="min-h-0 flex-1 overflow-auto">
                {tokensLoading ? (
                    <p className="p-6 text-sm text-muted-foreground" aria-live="polite">
                        Tokenizing with {gridLabel(definition.grid)}…
                    </p>
                ) : (
                    <AlgorithmGrid
                        definition={shown}
                        tokens={tokens}
                        evaluation={evaluation}
                        types={shownTypes}
                        outputId={shown.output}
                        view={view}
                        selectedId={draft?.id ?? null}
                        pendingCell={draft?.cell ?? null}
                        argKeys={refKeys(draft)}
                        picking={picking}
                        problemIds={problemIds}
                        specialTokens={specialSet}
                        markingSpecials={markingSpecials}
                        onCellClick={onCellClick}
                        onTokenClick={onTokenClick}
                        onVariableClick={onVariableClick}
                        moveProblem={gridMoveProblem}
                        onMove={onMove}
                        onCopyTo={onCopyTo}
                    />
                )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t px-4 py-2 text-xs text-muted-foreground">
                <span className="tabular-nums">
                    {definition.variables.length} variable
                    {definition.variables.length === 1 ? "" : "s"} · {tokens.length} tokens ·{" "}
                    {definition.grid.layers} layers
                </span>
                <span className="flex items-center gap-3">
                    {outputVar ? (
                        <span title={`Output variable: ${outputVar.name}`}>
                            Output{" "}
                            <span className="font-mono text-foreground">
                                {show(outputOf(shown, evaluation))}
                            </span>
                        </span>
                    ) : (
                        <span>No output yet</span>
                    )}
                    {problems.length > 0 && (
                        <span className="text-amber-700 dark:text-amber-400">
                            {problems.length} problem{problems.length === 1 ? "" : "s"}
                        </span>
                    )}
                    {hasPython && python.status === "loading" && (
                        <span aria-live="polite">Loading Python…</span>
                    )}
                    {hasPython && python.status === "failed" && (
                        <span className="text-destructive">
                            Python couldn&apos;t load.{" "}
                            <Button
                                variant="link"
                                size="sm"
                                className="h-auto p-0 text-xs"
                                onClick={retryPython}
                            >
                                Retry
                            </Button>
                        </span>
                    )}
                </span>
            </div>
        </div>
    );

    const sidePanel =
        draft && draftIssues && draftTypeInfo ? (
            <VariablePanel
                draft={draft}
                definition={definition}
                tokens={tokens}
                typeInfo={draftTypeInfo}
                typeOfRef={typeOfRef}
                preview={evaluation.values[draft.id] ?? null}
                pythonStatus={python.status}
                tagSuggestions={tagSuggestions}
                clipboardName={clipboard?.name ?? null}
                onCopy={onCopyVariable}
                onPaste={onPaste}
                problems={draftIssues}
                onChange={changeDraft}
                onSave={onSave}
                onCancel={() => setDraft(null)}
                onDelete={onDelete}
            />
        ) : (
            <AlgorithmPanel
                algorithmId={algorithmId}
                definition={definition}
                tokens={tokens}
                evaluation={evaluation}
                types={shownTypes}
                problems={problems}
                saveState={saveState}
                versionState={versionState}
                canSave={!problems.length && versionState !== "saved"}
                savingVersion={savingVersion}
                onSaveVersion={() => void onSaveVersion()}
                onRevert={onRevert}
                algorithms={algorithmList ?? []}
                prompt={prompt}
                onRename={(name) => commit({ ...definition, name })}
                onUsePrompt={setPrompt}
                onSaveInput={onSaveInput}
                onRemoveInput={onRemoveInput}
                markingSpecials={markingSpecials}
                onToggleMarking={() => setMarkingSpecials((m) => !m)}
                onWalkthrough={() =>
                    setWalkthrough({ ...walkthrough, open: true, step: walkthrough?.step ?? 0 })
                }
                onEditVariable={(id) => {
                    const v = definition.variables.find((x) => x.id === id);
                    if (v) setDraft(draftFromVariable(definition, v));
                }}
                onLoadExample={onLoadExample}
                onUseCurrentPrompt={() => commit({ ...definition, template: prompt })}
                onSwitchAlgorithm={(id) => void switchAlgorithm(id)}
            />
        );

    if (mobile) {
        return dock(
            <div className="flex flex-col gap-2">
                <div className="min-h-[60vh] rounded border bg-secondary/80 dark:bg-secondary/50">
                    {gridPanel}
                </div>
                <div className="rounded border bg-secondary/80 dark:bg-secondary/50">
                    {sidePanel}
                </div>
            </div>,
        );
    }

    return dock(
        <ResizablePanelGroup
            direction="horizontal"
            className="flex h-full min-w-0 flex-1 rounded border bg-secondary/80 dark:bg-secondary/50"
        >
            <ResizablePanel id="grid" order={1} defaultSize={70} minSize={40} className="min-w-0">
                {gridPanel}
            </ResizablePanel>
            <ResizableHandle className="w-[0.8px]" />
            <ResizablePanel id="panel" order={2} defaultSize={30} minSize={22} className="min-w-0">
                {sidePanel}
            </ResizablePanel>
        </ResizablePanelGroup>,
    );
}

import { Button } from "@/components/ui/button";
import type { AlgorithmHypothesisMode } from "@/types/algorithmHypothesis";

const MODES: { mode: AlgorithmHypothesisMode; label: string }[] = [
    { mode: "edit", label: "Edit" },
    { mode: "intervene", label: "Intervene" },
];

/** Switch between building the algorithm and intervening on it. */
export function ModeTabs({
    mode,
    onModeChange,
}: {
    mode: AlgorithmHypothesisMode;
    onModeChange: (mode: AlgorithmHypothesisMode) => void;
}) {
    return (
        <div
            className="flex items-center gap-0.5 rounded-md border p-0.5"
            role="group"
            aria-label="Mode"
        >
            {MODES.map((m) => (
                <Button
                    key={m.mode}
                    size="sm"
                    variant={mode === m.mode ? "secondary" : "ghost"}
                    aria-pressed={mode === m.mode}
                    className="h-7 px-2.5"
                    onClick={() => onModeChange(m.mode)}
                >
                    {m.label}
                </Button>
            ))}
        </div>
    );
}

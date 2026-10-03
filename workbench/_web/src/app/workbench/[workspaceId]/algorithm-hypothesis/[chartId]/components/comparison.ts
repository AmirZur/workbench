"use client";

import { useMemo } from "react";
import type { AlgorithmDefinition } from "@/types/algorithmHypothesis";
import { sameDefinition, upgradeDefinition } from "@/lib/algorithmHypothesis/engine";
import { tokenizeAbstract } from "@/lib/algorithmHypothesis/grids";
import {
    ALGORITHM_COLORS,
    EXAMPLE_KINDS,
    EXAMPLE_NAMES,
    entityBindingExample,
} from "@/lib/algorithmHypothesis/presets";
import { useSavedAlgorithms } from "@/lib/api/algorithmApi";

/** One algorithm the intervention and sweep views run alongside this one. */
export interface ComparedAlgorithm {
    key: string;
    name: string;
    group: "this" | "saved" | "paper";
    note?: string;
    /** A swatch for the paper's three mechanisms. */
    color?: string;
    definition: AlgorithmDefinition;
    /** Template tokens; a custom function's `template` parameter reads them. */
    templateTokens: string[];
}

/**
 * This algorithm (its working copy), the saved version of every other saved
 * algorithm in the workspace on the same grid, and the paper's examples placed
 * on this algorithm's template.
 */
export function useComparedAlgorithms({
    workspaceId,
    algorithmId,
    definition,
    savedDefinition,
    templateTokens,
    enabled = true,
}: {
    workspaceId: string;
    algorithmId: string;
    definition: AlgorithmDefinition;
    savedDefinition: AlgorithmDefinition | null;
    templateTokens: string[];
    enabled?: boolean;
}): ComparedAlgorithm[] {
    const { data: saved } = useSavedAlgorithms(workspaceId, enabled);
    return useMemo(() => {
        const sameGrid = (d: AlgorithmDefinition) =>
            d.grid.kind === definition.grid.kind &&
            d.grid.layers === definition.grid.layers &&
            d.grid.model === definition.grid.model;
        const unsaved = !savedDefinition
            ? "this algorithm, not saved yet"
            : sameDefinition(savedDefinition, definition)
              ? "this algorithm"
              : "this algorithm, unsaved changes";
        const out: ComparedAlgorithm[] = [
            {
                key: "this",
                name: definition.name,
                group: "this",
                note: unsaved,
                definition,
                templateTokens,
            },
        ];
        for (const row of saved ?? []) {
            if (row.id === algorithmId) continue;
            const d = upgradeDefinition(row.definition);
            if (!sameGrid(d) || !d.output) continue;
            // Abstract templates tokenize here; a model grid's other templates
            // would need the tokenizer, so they reuse this one's.
            const template =
                d.grid.kind === "abstract" ? tokenizeAbstract(d.template) : templateTokens;
            out.push({
                key: row.id,
                name: d.name,
                group: "saved",
                definition: d,
                templateTokens: template,
            });
        }
        for (const kind of EXAMPLE_KINDS) {
            const d = entityBindingExample(
                kind,
                templateTokens,
                definition.grid,
                definition.template,
            );
            if (typeof d === "string") break;
            out.push({
                key: `paper-${kind}`,
                name: EXAMPLE_NAMES[kind],
                group: "paper",
                note: kind === "mixed" ? "illustrative weights" : undefined,
                color: kind === "mixed" ? undefined : ALGORITHM_COLORS[kind],
                definition: d,
                templateTokens,
            });
        }
        return out;
    }, [saved, algorithmId, definition, savedDefinition, templateTokens]);
}

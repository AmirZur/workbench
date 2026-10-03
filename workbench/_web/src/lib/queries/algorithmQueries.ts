"use server";

import { db } from "@/db/client";
import { algorithms, AlgorithmRow } from "@/db/schema";
import type { AlgorithmDefinition } from "@/types/algorithmHypothesis";
import { desc, eq } from "drizzle-orm";
import { touchWorkspace } from "@/lib/queries/workspaceQueries";

/**
 * Algorithm Hypothesis algorithms: workspace-scoped rows holding a schema-v2
 * definition. Charts point at one by id, so several charts can share it.
 */

export interface AlgorithmListItem {
    id: string;
    name: string;
    updatedAt: Date;
}

export const createAlgorithm = async (
    workspaceId: string,
    definition: AlgorithmDefinition,
): Promise<AlgorithmRow> => {
    const [row] = await db
        .insert(algorithms)
        .values({ workspaceId, name: definition.name, definition })
        .returning();
    await touchWorkspace(workspaceId);
    return row as AlgorithmRow;
};

export const getAlgorithmById = async (id: string): Promise<AlgorithmRow | null> => {
    const [row] = await db.select().from(algorithms).where(eq(algorithms.id, id));
    return (row ?? null) as AlgorithmRow | null;
};

export const getAlgorithmsForWorkspace = async (
    workspaceId: string,
): Promise<AlgorithmListItem[]> => {
    const rows = await db
        .select({ id: algorithms.id, name: algorithms.name, updatedAt: algorithms.updatedAt })
        .from(algorithms)
        .where(eq(algorithms.workspaceId, workspaceId))
        .orderBy(desc(algorithms.updatedAt));
    return rows as AlgorithmListItem[];
};

/** Every algorithm in the workspace with its definition, for running the same
 * intervention on all of them. */
export const getAlgorithmDefinitionsForWorkspace = async (
    workspaceId: string,
): Promise<{ id: string; definition: AlgorithmDefinition }[]> => {
    const rows = await db
        .select({ id: algorithms.id, definition: algorithms.definition })
        .from(algorithms)
        .where(eq(algorithms.workspaceId, workspaceId))
        .orderBy(desc(algorithms.updatedAt));
    return rows as { id: string; definition: AlgorithmDefinition }[];
};

/** Replace the definition. The `name` column follows definition.name. */
export const updateAlgorithm = async (
    id: string,
    definition: AlgorithmDefinition,
): Promise<AlgorithmRow | null> => {
    const [row] = await db
        .update(algorithms)
        .set({ name: definition.name, definition })
        .where(eq(algorithms.id, id))
        .returning();
    if (row) await touchWorkspace(row.workspaceId);
    return (row ?? null) as AlgorithmRow | null;
};

/** A copy in the same workspace, for copied charts. */
export const duplicateAlgorithm = async (id: string): Promise<AlgorithmRow | null> => {
    const original = await getAlgorithmById(id);
    if (!original) return null;
    const definition = original.definition as AlgorithmDefinition;
    return createAlgorithm(original.workspaceId, {
        ...definition,
        name: `Copy of ${definition.name}`,
    });
};

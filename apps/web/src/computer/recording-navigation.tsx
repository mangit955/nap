"use client";
import { createContext } from "react";

/** The workspace owns the viewer and resolves this turn against its existing event log. */
export const RecordingNavigation = createContext<((turnId: string) => void) | undefined>(undefined);

"use client";
import { createContext } from "react";

/** Transcript rows and cards seek the same Computer tab owned by the workspace. */
export const ComputerNavigation = createContext<((seq: number | null) => void) | undefined>(
  undefined,
);

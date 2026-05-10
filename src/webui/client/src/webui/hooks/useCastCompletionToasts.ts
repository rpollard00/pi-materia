import { useEffect, useRef } from 'react';
import { toast } from '../../toast/index.js';
import type { MonitorSnapshot } from '../types.js';

interface ObservedActiveCast {
  castId: string;
  phase?: string;
  currentNode?: string;
  currentMateria?: string;
}

function isCompleteState(value: string | undefined) {
  return value === 'complete' || value === 'completed' || value === 'done';
}

function describeCompletedCast(cast: ObservedActiveCast) {
  const location = cast.currentMateria ?? cast.currentNode ?? cast.phase;
  return location ? `Cast ${cast.castId} finished after ${location}.` : `Cast ${cast.castId} finished.`;
}

export function useCastCompletionToasts(monitor: MonitorSnapshot | undefined) {
  const previousActiveCastRef = useRef<ObservedActiveCast | undefined>(undefined);
  const notifiedCastIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const activeCast = monitor?.activeCast;
    const previousActiveCast = previousActiveCastRef.current;

    if (!activeCast) {
      if (previousActiveCast && !notifiedCastIdsRef.current.has(previousActiveCast.castId)) {
        notifiedCastIdsRef.current.add(previousActiveCast.castId);
        toast({
          id: `cast-complete:${previousActiveCast.castId}`,
          title: 'Cast completed',
          description: describeCompletedCast(previousActiveCast),
          variant: 'success',
        });
      }
      previousActiveCastRef.current = undefined;
      return;
    }

    const terminal = isCompleteState(activeCast.phase) || isCompleteState(activeCast.nodeState);
    const currentlyActive = activeCast.active && !terminal;

    if (currentlyActive) {
      previousActiveCastRef.current = {
        castId: activeCast.castId,
        phase: activeCast.phase,
        currentNode: activeCast.currentNode,
        currentMateria: activeCast.currentMateria,
      };
      return;
    }

    if (previousActiveCast?.castId === activeCast.castId && !notifiedCastIdsRef.current.has(activeCast.castId)) {
      notifiedCastIdsRef.current.add(activeCast.castId);
      toast({
        id: `cast-complete:${activeCast.castId}`,
        title: 'Cast completed',
        description: describeCompletedCast({
          castId: activeCast.castId,
          phase: activeCast.phase ?? previousActiveCast.phase,
          currentNode: activeCast.currentNode ?? previousActiveCast.currentNode,
          currentMateria: activeCast.currentMateria ?? previousActiveCast.currentMateria,
        }),
        variant: terminal ? 'success' : 'info',
      });
    }

    previousActiveCastRef.current = undefined;
  }, [monitor]);
}

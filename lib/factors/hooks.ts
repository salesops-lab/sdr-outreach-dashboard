/**
 * React hooks for the Website Activity feature
 */

"use client";

import { useState, useCallback } from "react";

/**
 * Hook to manage the website activity modal state
 */
export function useWebsiteActivityModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [ownerName, setOwnerName] = useState<string>("");
  const [days, setDays] = useState<number>(2);

  const openModal = useCallback((ownerId: string, ownerName: string, days?: number) => {
    setOwnerId(ownerId);
    setOwnerName(ownerName);
    if (days !== undefined) {
      setDays(days);
    }
    setIsOpen(true);
  }, []);

  const closeModal = useCallback(() => {
    setIsOpen(false);
    setOwnerId(null);
    setOwnerName("");
  }, []);

  return {
    isOpen,
    ownerId,
    ownerName,
    days,
    openModal,
    closeModal,
  };
}

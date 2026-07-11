/**
 * WebsiteActivityButton Component
 * 
 * A button that opens the WebsiteActivityModal when clicked.
 * This component is designed to be placed in the AppNav or any other location.
 * 
 * Usage:
 * ```tsx
 * <WebsiteActivityButton ownerId="12345" ownerName="John Doe" />
 * ```
 */

"use client";

import { useState } from "react";
import { Eye } from "lucide-react";
import WebsiteActivityModal from "./WebsiteActivityModal";

interface WebsiteActivityButtonProps {
  ownerId: string;
  ownerName: string;
  days?: number;
  className?: string;
}

/**
 * WebsiteActivityButton component
 * 
 * Displays a button that opens a modal showing website activity for the rep's companies.
 */
export default function WebsiteActivityButton({
  ownerId,
  ownerName,
  days = 2,
  className = "",
}: WebsiteActivityButtonProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);

  const handleOpen = () => setIsModalOpen(true);
  const handleClose = () => setIsModalOpen(false);

  return (
    <>
      <button
        onClick={handleOpen}
        className={`flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${className}`}
        title={`View website activity for ${ownerName}`}
      >
        <Eye className="h-4 w-4" />
        <span>Website Activity</span>
      </button>

      {isModalOpen && (
        <WebsiteActivityModal
          ownerId={ownerId}
          ownerName={ownerName}
          onClose={handleClose}
          days={days}
        />
      )}
    </>
  );
}

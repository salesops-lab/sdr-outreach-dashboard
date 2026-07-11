/**
 * WebsiteActivityNav Component
 * 
 * A standalone navigation component that provides the "View Website Activity" button.
 * This component is designed to be placed in the top navigation area alongside AppNav.
 * 
 * This is a SEPARATE feature that does not modify the existing AppNav component.
 * 
 * Usage:
 * ```tsx
 * // In your layout or page component:
 * <AppNav active={active} viewer={viewer} />
 * <WebsiteActivityNav viewer={viewer} />
 * ```
 */

"use client";

import { useState } from "react";
import { Eye } from "lucide-react";
import { Viewer } from "../lib/spine/types";
import { resolveRep } from "../config/reps";
import WebsiteActivityModal from "./WebsiteActivityModal";

interface WebsiteActivityNavProps {
  viewer: Viewer;
  className?: string;
}

/**
 * WebsiteActivityNav component
 * 
 * Provides a "View Website Activity" button in the top navigation.
 * When clicked, opens a modal showing website activity for the viewer's assigned companies.
 * 
 * For reps (SDRs and AEs), this shows activity for their own assigned companies.
 * For admins/managers, this shows activity for all companies (or allows selection).
 */
export default function WebsiteActivityNav({
  viewer,
  className = "",
}: WebsiteActivityNavProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  
  // Get the primary owner ID for this viewer
  // For reps, this is their own owner ID
  // For admins/managers, we use the first owner ID or prompt for selection
  const primaryOwnerId = viewer.defaultOwnerIds[0];
  const ownerName = resolveRep(primaryOwnerId);

  // Only show the button if we have a valid owner ID
  if (!primaryOwnerId) {
    return null;
  }

  const handleOpen = () => setIsModalOpen(true);
  const handleClose = () => setIsModalOpen(false);

  return (
    <>
      <div className={className}>
        <button
          onClick={handleOpen}
          className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors text-ink-muted hover:bg-surface-muted hover:text-ink"
          title={`View website activity for ${ownerName || primaryOwnerId}`}
        >
          <Eye className="h-4 w-4" />
          <span>Website Activity</span>
        </button>
      </div>

      {isModalOpen && primaryOwnerId && (
        <WebsiteActivityModal
          ownerId={primaryOwnerId}
          ownerName={ownerName || primaryOwnerId}
          onClose={handleClose}
          days={2}
        />
      )}
    </>
  );
}

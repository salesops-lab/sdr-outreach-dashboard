/**
 * WebsiteActivityModal Component
 * 
 * A modal dialog that displays website activity for a rep's assigned companies.
 * Fetches data from the Factors API via the /api/website-activity endpoint.
 * 
 * Features:
 * - Shows user timelines with their activities
 * - Displays page views, sessions, and other events
 * - Shows timestamps, durations, and other metadata
 * - Filterable by date range and event type
 */

"use client";

import { useState, useEffect, useCallback, Fragment } from "react";
import { X, Eye, Clock, User, Building, Globe, Filter, Search } from "lucide-react";
import type { EnhancedUserTimeline, EnhancedUserActivity } from "../lib/factors/types";

interface WebsiteActivityModalProps {
  ownerId: string;
  ownerName: string;
  onClose: () => void;
  days?: number;
}

interface CompanyActivityData {
  domain: string;
  timelines: EnhancedUserTimeline[];
  error?: string;
}

interface ApiResponse {
  success: boolean;
  owner_name: string;
  companies: CompanyActivityData[];
  time_range: { from: string; to: string };
  error?: string;
}

/**
 * Icon mapping for different event types
 */
const EVENT_ICONS: Record<string, React.ReactNode> = {
  $session: <Globe className="h-4 w-4" />,
  $pageView: <Eye className="h-4 w-4" />,
  signup_completed: <User className="h-4 w-4" />,
  "Session Started": <Globe className="h-4 w-4" />,
  "Page View": <Eye className="h-4 w-4" />,
  default: <Clock className="h-4 w-4" />,
};

/**
 * Get icon for an event
 */
function getEventIcon(eventName: string): React.ReactNode {
  const key = eventName.toLowerCase();
  for (const [pattern, icon] of Object.entries(EVENT_ICONS)) {
    if (key.includes(pattern.toLowerCase())) {
      return icon;
    }
  }
  return EVENT_ICONS.default;
}

/**
 * Format duration in seconds to human-readable format
 */
function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || seconds === 0) return "-";
  
  if (seconds < 60) {
    return `${seconds}s`;
  }
  
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  
  return remainingMinutes > 0
    ? `${hours}h ${remainingMinutes}m`
    : `${hours}h`;
}

/**
 * Get a CSS class for event type styling
 */
function getEventTypeClass(eventType: string): string {
  const type = eventType.toLowerCase();
  
  if (type.includes("session")) return "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300";
  if (type.includes("page") || type.includes("view")) return "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300";
  if (type.includes("user") || type.includes("signup")) return "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300";
  if (type.includes("click")) return "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300";
  
  return "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200";
}

/**
 * ActivityRow component - displays a single activity
 */
function ActivityRow({ activity }: { activity: EnhancedUserActivity }) {
  const icon = getEventIcon(activity.event_name || activity.display_name);
  const typeClass = getEventTypeClass(activity.event_type);
  const pageUrl = activity.parsed_properties.$page_url;
  const duration = activity.parsed_properties.duration;
  
  return (
    <div className="flex items-start gap-3 p-3 rounded-lg hover:bg-surface-muted transition-colors">
      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-surface-muted flex items-center justify-center">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${typeClass}`}>
            {activity.display_name || activity.event_name}
          </span>
          <span className="text-xs text-ink-subtle">
            {activity.formatted_date} at {activity.formatted_time}
          </span>
        </div>
        
        {pageUrl && (
          <div className="mt-1">
            <a
              href={pageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-primary hover:underline truncate max-w-md"
            >
              {pageUrl}
            </a>
          </div>
        )}
        
        {duration !== undefined && (
          <div className="mt-1 flex items-center gap-1 text-xs text-ink-subtle">
            <Clock className="h-3 w-3" />
            <span>Duration: {formatDuration(duration)}</span>
          </div>
        )}
        
        {activity.parsed_properties.utm_source && (
          <div className="mt-1 flex items-center gap-1 text-xs text-ink-subtle">
            <span>Source: {activity.parsed_properties.utm_source}</span>
            {activity.parsed_properties.utm_medium && (
              <span>, Medium: {activity.parsed_properties.utm_medium}</span>
            )}
            {activity.parsed_properties.utm_campaign && (
              <span>, Campaign: {activity.parsed_properties.utm_campaign}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * UserTimelineSection component - displays all activities for a single user
 */
function UserTimelineSection({ timeline }: { timeline: EnhancedUserTimeline }) {
  const [isExpanded, setIsExpanded] = useState(true);
  const userEmail = timeline.parsed_user_properties.email;
  const userName = timeline.user_name;
  
  return (
    <div className="border border-line rounded-xl overflow-hidden">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between p-4 hover:bg-surface-muted transition-colors text-left"
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-primary-weak flex items-center justify-center">
            <User className="h-5 w-5 text-primary" />
          </div>
          <div>
            <div className="font-semibold text-ink">
              {userName || "Anonymous User"}
            </div>
            {userEmail && (
              <div className="text-sm text-ink-subtle">{userEmail}</div>
            )}
            {!timeline.is_anonymous && (
              <div className="text-xs text-ink-muted">
                User ID: {timeline.user_id}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-ink-subtle">
            {timeline.enhanced_activities.length} activities
          </span>
          <span className="text-ink-subtle">
            {isExpanded ? "▼" : "▶"}
          </span>
        </div>
      </button>
      
      {isExpanded && (
        <div className="p-4 pt-0">
          {timeline.enhanced_activities.length > 0 ? (
            <div className="space-y-2">
              {timeline.enhanced_activities.map((activity, index) => (
                <ActivityRow key={`${activity.event_id}-${index}`} activity={activity} />
              ))}
            </div>
          ) : (
            <div className="text-center py-4 text-ink-subtle text-sm">
              No activities recorded
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * CompanySection component - displays all user timelines for a company
 */
function CompanySection({ 
  companyData 
}: { 
  companyData: CompanyActivityData 
}) {
  const [isExpanded, setIsExpanded] = useState(true);
  const totalUsers = companyData.timelines.length;
  const totalActivities = companyData.timelines.reduce(
    (sum, timeline) => sum + timeline.enhanced_activities.length,
    0
  );
  
  return (
    <div className="border border-line rounded-xl overflow-hidden">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between p-4 hover:bg-surface-muted transition-colors text-left"
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-surface-muted flex items-center justify-center">
            <Building className="h-5 w-5 text-ink" />
          </div>
          <div>
            <div className="font-semibold text-ink">{companyData.domain}</div>
            {companyData.error && (
              <div className="text-sm text-red-600 dark:text-red-400">
                Error: {companyData.error}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-ink-subtle">
            {totalUsers} users • {totalActivities} activities
          </span>
          <span className="text-ink-subtle">
            {isExpanded ? "▼" : "▶"}
          </span>
        </div>
      </button>
      
      {isExpanded && !companyData.error && (
        <div className="p-4 pt-0 space-y-4">
          {companyData.timelines.length > 0 ? (
            companyData.timelines.map((timeline, index) => (
              <UserTimelineSection
                key={`${timeline.user_id}-${index}`}
                timeline={timeline}
              />
            ))
          ) : (
            <div className="text-center py-4 text-ink-subtle text-sm">
              No website activity found for this company
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Loading state component
 */
function LoadingState() {
  return (
    <div className="flex flex-col items-center justify-center py-12">
      <div className="animate-spin rounded-full h-12 w-12 border-4 border-primary border-t-transparent" />
      <p className="mt-4 text-ink-subtle">Loading website activity...</p>
    </div>
  );
}

/**
 * Error state component
 */
function ErrorState({ error }: { error: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="w-16 h-16 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
        <X className="h-8 w-8 text-red-600 dark:text-red-400" />
      </div>
      <h3 className="mt-4 font-semibold text-red-600 dark:text-red-400">
        Error Loading Data
      </h3>
      <p className="mt-2 text-ink-subtle">{error}</p>
    </div>
  );
}

/**
 * Empty state component
 */
function EmptyState({ ownerName }: { ownerName: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="w-16 h-16 rounded-full bg-surface-muted flex items-center justify-center">
        <Globe className="h-8 w-8 text-ink-subtle" />
      </div>
      <h3 className="mt-4 font-semibold text-ink">
        No Website Activity Found
      </h3>
      <p className="mt-2 text-ink-subtle">
        No website activity was recorded for {ownerName}'s assigned companies in the last 2 days.
      </p>
    </div>
  );
}

/**
 * Main WebsiteActivityModal component
 */
export default function WebsiteActivityModal({
  ownerId,
  ownerName,
  onClose,
  days = 2,
}: WebsiteActivityModalProps) {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterEventType, setFilterEventType] = useState<string | null>(null);
  
  /**
   * Fetch website activity data
   */
  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      
      const response = await fetch(
        `/api/website-activity?owner_id=${encodeURIComponent(ownerId)}&days=${days}`
      );
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "Failed to fetch website activity");
      }
      
      const result = await response.json() as ApiResponse;
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load website activity");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [ownerId, days]);
  
  /**
   * Fetch data on mount
   */
  useEffect(() => {
    fetchData();
  }, [fetchData]);
  
  /**
   * Filter timelines based on search query and event type filter
   */
  const filterTimelines = useCallback((
    timelines: EnhancedUserTimeline[],
    query: string,
    eventType: string | null
  ): EnhancedUserTimeline[] => {
    const lowerQuery = query.toLowerCase();
    
    return timelines.filter((timeline) => {
      // Filter by search query (user name, email, or activities)
      const matchesQuery = (
        lowerQuery === "" ||
        timeline.user_name.toLowerCase().includes(lowerQuery) ||
        timeline.parsed_user_properties.email?.toLowerCase().includes(lowerQuery) ||
        timeline.enhanced_activities.some(
          (activity) =>
            activity.event_name.toLowerCase().includes(lowerQuery) ||
            activity.display_name.toLowerCase().includes(lowerQuery) ||
            activity.parsed_properties.$page_url?.toLowerCase().includes(lowerQuery)
        )
      );
      
      // Filter by event type
      const matchesEventType = eventType === null ||
        timeline.enhanced_activities.some(
          (activity) => activity.event_type === eventType
        );
      
      return matchesQuery && matchesEventType;
    });
  }, []);
  
  /**
   * Get filtered company data
   */
  const getFilteredData = useCallback(() => {
    if (!data || !data.success) return [];
    
    return data.companies.map((company) => {
      const filteredTimelines = filterTimelines(
        company.timelines,
        searchQuery,
        filterEventType
      );
      
      return {
        ...company,
        timelines: filteredTimelines,
      };
    }).filter((company) => company.timelines.length > 0 || company.error);
  }, [data, searchQuery, filterEventType, filterTimelines]);
  
  /**
   * Get all unique event types for the filter dropdown
   */
  const getEventTypes = useCallback((): string[] => {
    if (!data || !data.success) return [];
    
    const eventTypes = new Set<string>();
    
    data.companies.forEach((company) => {
      company.timelines.forEach((timeline) => {
        timeline.enhanced_activities.forEach((activity) => {
          if (activity.event_type) {
            eventTypes.add(activity.event_type);
          }
        });
      });
    });
    
    return Array.from(eventTypes).sort();
  }, [data]);
  
  const filteredData = getFilteredData();
  const eventTypes = getEventTypes();
  const totalActivities = filteredData.reduce(
    (sum, company) =>
      sum + company.timelines.reduce(
        (companySum, timeline) => companySum + timeline.enhanced_activities.length,
        0
      ),
    0
  );
  
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="w-full max-w-4xl max-h-[90vh] bg-surface rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-line">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-primary-weak flex items-center justify-center">
              <Globe className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-ink">
                Website Activity
              </h2>
              <p className="text-sm text-ink-subtle">
                {ownerName}'s assigned companies • Last {days} days
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-surface-muted rounded-lg transition-colors"
          >
            <X className="h-5 w-5 text-ink-subtle" />
          </button>
        </div>
        
        {/* Filters */}
        <div className="p-4 border-b border-line">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-subtle" />
              <input
                type="text"
                placeholder="Search users, pages, events..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 bg-surface-muted border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-weak focus:border-transparent"
              />
            </div>
            
            {eventTypes.length > 0 && (
              <div className="relative">
                <select
                  value={filterEventType || ""}
                  onChange={(e) => setFilterEventType(e.target.value || null)}
                  className="pl-4 pr-8 py-2 bg-surface-muted border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-weak focus:border-transparent appearance-none"
                >
                  <option value="">All Event Types</option>
                  {eventTypes.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
                <Filter className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-subtle pointer-events-none" />
              </div>
            )}
            
            <button
              onClick={fetchData}
              className="px-4 py-2 bg-primary-weak text-primary font-medium rounded-lg text-sm hover:bg-primary transition-colors"
            >
              Refresh
            </button>
          </div>
          
          {/* Summary */}
          {data && data.success && (
            <div className="mt-3 flex items-center gap-4 text-xs text-ink-subtle flex-wrap">
              <span>
                Time range: {data.time_range.from} to {data.time_range.to}
              </span>
              <span>
                • {filteredData.length} companies with activity
              </span>
              <span>
                • {totalActivities} total activities
              </span>
            </div>
          )}
        </div>
        
        {/* Content */}
        <div className="overflow-y-auto max-h-[calc(90vh-200px)]">
          {loading ? (
            <LoadingState />
          ) : error ? (
            <ErrorState error={error} />
          ) : filteredData && filteredData.length > 0 ? (
            <div className="p-4 space-y-4">
              {filteredData.map((company, index) => (
                <CompanySection key={`${company.domain}-${index}`} companyData={company} />
              ))}
            </div>
          ) : (
            <EmptyState ownerName={ownerName} />
          )}
        </div>
        
        {/* Footer */}
        <div className="p-4 border-t border-line flex items-center justify-between text-xs text-ink-subtle">
          <span>Data from Factors API</span>
          <span>Last updated: {new Date().toLocaleTimeString()}</span>
        </div>
      </div>
    </div>
  );
}

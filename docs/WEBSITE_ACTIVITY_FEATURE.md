# Website Activity Feature

## Overview

This feature provides SDRs and AEs with the ability to view website activity on their assigned accounts. It integrates with the Factors Account Journey API to fetch and display user interactions, page views, sessions, and other activities.

## Features

- **View Website Activity Button**: Added to the top navigation bar
- **Modal Display**: Shows detailed website activity in a modal dialog
- **Filtering**: Search by users, pages, events; filter by event type
- **Collapsible Sections**: Organized by company and user for easy navigation
- **Enhanced Data**: Parsed properties, formatted timestamps, duration calculations

## API Integration

### Factors Account Journey API

- **Base URL**: `https://api.factors.ai/open/v1`
- **Endpoint**: `/account/{account_domain}/journey`
- **API Key**: `ad9d0b20e949a90d3e6a6c2ba83c1ef2` (to be rotated later)
- **Authentication**: Bearer Token

### API Parameters

- `account_domain` (required): The domain name of the account
- `from` (optional): Start timestamp (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS.ffffff)
- `to` (optional): End timestamp (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS.ffffff)
- `event_name` (optional): Filter by event name (case-insensitive substring)
- `user_name` (optional): Filter by user name (case-insensitive substring)

## Components

### 1. `WebsiteActivityNav`

Standalone navigation component that provides the "View Website Activity" button.

**Location**: `components/WebsiteActivityNav.tsx`

**Usage**:
```tsx
<WebsiteActivityNav viewer={viewer} />
```

**Props**:
- `viewer`: The Viewer object from the spine types
- `className`: Optional CSS classes

### 2. `WebsiteActivityModal`

Modal dialog that displays website activity data.

**Location**: `components/WebsiteActivityModal.tsx`

**Features**:
- Fetches data from `/api/website-activity` endpoint
- Displays activity organized by company and user
- Search and filter capabilities
- Loading, error, and empty states
- Collapsible sections for better UX

### 3. `WebsiteActivityButton`

Simple button component that opens the modal.

**Location**: `components/WebsiteActivityButton.tsx`

**Usage**:
```tsx
<WebsiteActivityButton ownerId="12345" ownerName="John Doe" />
```

## API Routes

### GET `/api/website-activity`

Fetches website activity for a rep's assigned companies.

**Query Parameters**:
- `owner_id` (required): HubSpot owner ID of the rep
- `days` (optional): Number of days to look back (default: 2, max: 30)

**Response**:
```json
{
  "success": true,
  "owner_name": "John Doe",
  "companies": [
    {
      "domain": "company.com",
      "timelines": [...],
      "error": null
    }
  ],
  "time_range": {
    "from": "2024-01-13",
    "to": "2024-01-15"
  }
}
```

### POST `/api/website-activity`

Batch request for multiple reps.

**Request Body**:
```json
{
  "owner_ids": ["12345", "67890"],
  "days": 2
}
```

## Types

### Core Types

**Location**: `lib/factors/types.ts`

- `UserActivity`: Single event/action performed by a user
- `UserTimeline`: User with their activities within a timeframe
- `AccountJourneyResponse`: Array of UserTimeline objects
- `EnhancedUserTimeline`: Timeline with parsed properties and formatted timestamps

### Client Functions

**Location**: `lib/factors/client.ts`

- `fetchAccountJourney(params)`: Fetch raw data from Factors API
- `fetchEnhancedAccountJourney(params)`: Fetch data with enhanced properties
- `fetchWebsiteActivityForDomain(domain, days)`: Fetch activity for a specific domain
- `parseUserProperties(jsonString)`: Parse user properties from JSONB
- `parseEventProperties(jsonString)`: Parse event properties from JSONB
- `formatTimestamp(timestamp)`: Format Unix timestamp to readable strings
- `getDateDaysAgo(days)`: Get date string N days ago
- `getCurrentDate()`: Get current date string

## Implementation Details

### Data Flow

1. User clicks "Website Activity" button in navigation
2. Modal opens and fetches data from `/api/website-activity?owner_id=<id>&days=2`
3. API route validates the rep and fetches company domains
4. For each company domain, fetch data from Factors API
5. Enhance data with parsed properties and formatted timestamps
6. Return data to modal for display

### Company Domain Resolution

The current implementation uses a fallback mechanism:
1. Check if there's a cached mapping in `REP_COMPANY_DOMAINS`
2. If not, generate a domain from the rep's name (e.g., "John Doe" -> "john-doe.com")

**Note**: In production, this should be replaced with actual company domain data from HubSpot or a local database.

### Error Handling

- API errors are caught and displayed in the modal
- Invalid owner IDs return 404
- Missing parameters return 400
- Factors API errors are propagated with details

## Styling

The feature uses the existing design system:
- Colors: `primary`, `surface`, `ink`, `line`
- Typography: Follows existing patterns
- Icons: Uses Lucide React icons
- Spacing: Consistent with existing components

## Future Enhancements

1. **Real Company Domain Data**: Integrate with HubSpot to get actual assigned company domains
2. **Date Range Picker**: Allow users to select custom date ranges
3. **Export Data**: Add ability to export activity data as CSV/JSON
4. **Notifications**: Alert reps when new activity is detected
5. **Analytics**: Add charts and visualizations for activity trends
6. **Multi-Rep View**: Allow managers to view activity across multiple reps

## Security

- API key is stored in the client code (temporary - to be rotated)
- In production, consider using environment variables or a backend service
- All requests are validated on the server side

## Files Created

```
lib/factors/
  types.ts      # Type definitions for Factors API
  client.ts     # API client functions
  hooks.ts      # React hooks for the feature
  index.ts      # Module exports

components/
  WebsiteActivityNav.tsx      # Navigation component with button
  WebsiteActivityModal.tsx   # Modal dialog component
  WebsiteActivityButton.tsx  # Standalone button component

docs/
  WEBSITE_ACTIVITY_FEATURE.md  # This documentation

app/api/website-activity/
  route.ts      # API route handler
```

## Usage in Layout

To add the website activity button to your layout:

```tsx
// In your layout or page component
import AppNav from "../components/AppNav";
import WebsiteActivityNav from "../components/WebsiteActivityNav";

function MyLayout({ children, viewer }) {
  return (
    <>
      <AppNav active="overview" viewer={viewer} />
      <WebsiteActivityNav viewer={viewer} className="absolute top-4 right-20" />
      {children}
    </>
  );
}
```

Or place it directly in the AppNav component (if you decide to modify it):

```tsx
// In AppNav.tsx, add to the nav div:
<div className="flex items-center gap-1">
  {TABS.map((t) => tab(t.key, t.label, t.href))}
  {viewer.isAdmin && tab("admin", "Admin", "/admin")}
  <WebsiteActivityButton 
    ownerId={viewer.defaultOwnerIds[0]} 
    ownerName={resolveRep(viewer.defaultOwnerIds[0])} 
    className="text-ink-muted hover:bg-surface-muted hover:text-ink"
  />
</div>
```

## Testing

The feature can be tested by:
1. Running the development server
2. Logging in as a rep (SDR or AE)
3. Clicking the "Website Activity" button
4. Viewing the modal with activity data

Note: The Factors API key is temporary and will be rotated later.

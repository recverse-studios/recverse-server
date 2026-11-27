# RecVerse Server Services Documentation

This document details each service module, its endpoints, and implementation status.

## Service Overview

| Service | Module | Mount Path | Description |
|---------|--------|------------|-------------|
| Name Server | `verse-ns.js` | `/` | Service discovery endpoint |
| Accounts | `verse-accounts.js` | `/accounts` | Account management, profiles, lookups |
| Auth | `verse-auth.js` | `/auth` | OAuth2 tokens, authentication, device auth |
| API | `verse-api.js` | `/api` | Main game API (images, cheers, reports, friends, CAI) |
| Rooms | `verse-rooms.js` | `/rooms` | Room/subroom CRUD, saves, cloning |
| Matchmaking | `verse-match.js` | `/match` | Matchmaking, presence, Photon config |
| Chat | `verse-chat.js` | `/chat` | Chat messages, history |
| Economy | `verse-econ.js` | `/econ` | Currency, storefront, purchases, inventory |
| CDN | `verse-cdn.js` | `/cdn` | Content delivery (stub) |
| Images | `verse-img.js` | `/img` | Image serving (stub) |
| Notifications | `verse-notify.js` | `/notify` | Push notifications (stub) |
| Leaderboard | `verse-leaderboard.js` | `/leaderboard` | Leaderboards (stub) |
| Room Comments | `verse-roomcomments.js` | `/roomcomments` | Room comments (stub) |
| Player Settings | `verse-playersettings.js` | `/playersettings` | Player settings (stub) |
| Studio | `verse-studio.js` | `/studio` | Rec Room Studio (stub) |
| Commerce | `verse-commerce.js` | `/commerce` | Commerce/purchases (stub) |
| Data Collection | `verse-datacollection.js` | `/datacollection` | Analytics ingestion (stub) |
| Discovery | `verse-discovery.js` | `/discovery` | Service discovery (stub) |
| ... | ... | ... | ... |

---

## Name Server (`verse-ns.js`)

**Path:** `/`

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Service discovery document - returns `{serviceLabel: "https://subdomain.domain"}` map |
| GET | `/health` | Health check |

### Service Discovery

Returns a JSON object mapping service labels to URLs. The client fetches this first to discover all service endpoints.

```json
{
  "Accounts": "http://localhost:3000/accounts",
  "Auth": "http://localhost:3000/auth",
  "API": "http://localhost:3000/api",
  "Rooms": "http://localhost:3000/rooms",
  "Matchmaking": "http://localhost:3000/match",
  ...
}
```

### Implementation Notes

- Adapts RecFlare's subdomain-based discovery to path-based for monolithic server
- Uses `buildEndpoints()` from `verse-utils.js`
- Compatible with February 2023 client's discovery mechanism

---

## Accounts (`verse-accounts.js`)

**Path:** `/accounts`

### Endpoints

#### Public/Low-Auth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/emojiConfig/whitelistedEmojis` | No | Bare array of emoji strings |
| GET | `/account/search` | Optional | Prefix search by username |
| GET | `/account/username/:name` | Optional | Exact username lookup |
| GET | `/account` | Optional | Exact username lookup (query form) |
| GET | `/account/bulk` | Optional | Bulk lookup by IDs (GET) |
| POST | `/account/bulk` | Optional | Bulk lookup by IDs (POST form) |
| GET | `/account/:id/bio` | Optional | Player bio |
| GET | `/account/:id` | Optional | Public account by ID |
| POST | `/account/create` | No | Create new account |

#### Authenticated (Bearer JWT)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/account/me` | Self account (private fields) |
| GET | `/parentalcontrol/me` | Parental control flags |
| GET | `/accountprivacysettings/:id` | Privacy settings |
| PUT | `/account/me/displayname` | Set display name |
| PUT | `/account/me/username` | Change username (envelope response) |
| POST | `/account/me/email` | Stage email change |
| GET | `/account/me/email/pending` | Pending email change |
| POST | `/account/me/email/confirm` | Confirm email change |
| POST | `/account/me/phone` | Set phone number |
| PUT | `/account/me/identityflags` | Set identity flags bitmask |
| PUT | `/account/me/personalpronouns` | Set pronoun flags |
| PUT | `/account/me/bio` | Set bio (max 255 chars) |
| PUT | `/account/me/emoji` | Set display emoji (Plus required) |
| PUT | `/account/me/bannerimage` | Set banner image |
| PUT | `/account/me/profileimage` | Set profile image |

### Response Formats

#### Public Account DTO (`/account/:id`, `/account/search`, etc.)
```json
{
  "accountId": 123,
  "username": "player123",
  "displayName": "Player 123",
  "profileImage": "sharecamera/...",
  "bannerImage": "",
  "displayEmoji": "😀",
  "isJunior": false,
  "platforms": 1,
  "personalPronouns": 0,
  "identityFlags": 0,
  "createdAt": "2023-02-01T00:00:00.000Z"
}
```

#### Self Account DTO (`/account/me`)
```json
{
  ...publicDto,
  "email": "user@example.com",
  "birthday": "1904-01-01T00:00:00.000Z",
  "availableUsernameChanges": 3,
  "isDeleted": false
}
```

#### Username Change Result (always HTTP 200)
```json
{
  "success": true,
  "error": "",
  "value": { ...accountDto }
}
```

On error:
```json
{
  "success": false,
  "error": "That username is already taken.",
  "value": ""
}
```

### Implementation Notes

- Password hashing with bcrypt (cost 12)
- Email change is staged with confirmation codes (2-step)
- Username changes limited (default 3), tracked in DB
- Display emoji requires Rec Room Plus (`rn.plus` JWT claim)
- All profile mutations broadcast `AccountUpdate` via notifications hub
- Compatible with February 2023 client expectations

---

## Auth (`verse-auth.js`)

**Path:** `/auth`

### Endpoints

#### EAC / Platform

| Method | Path | Description |
|--------|------|-------------|
| GET | `/eac/challenge` | Returns `"AA=="` (text/plain) |
| GET/POST | `/cachedlogin/forplatformid/:platform/:id` | Cached login lookup |
| POST | `/cachedlogin/forplatformids` | Bulk cached login lookup |

#### Device Authorization (Studio)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/connect/deviceauthorization` | RFC 8628 device auth start |

#### OAuth2 Token

| Method | Path | Description |
|--------|------|-------------|
| POST | `/connect/token` | Main token endpoint |

**Supported Grants:**

1. **password** - Username/password login
   - Body: `grant_type=password&username=...&password=...&platform=...&platform_id=...&device_id=...&ver=20230201`
   - Links platform identity if provided

2. **cached_login** - Platform identity login
   - Body: `grant_type=cached_login&account_id=...&platform=...&platform_id=...&platform_auth=...&ver=...`

3. **refresh_token** - Token refresh
   - Body: `grant_type=refresh_token&refresh_token=...`

4. **identity_assertion** - Discord/third-party (website)
   - Body: `grant_type=identity_assertion&assertion=...`

5. **device_code** - Studio device approval
   - Body: `grant_type=device_code&device_code=...&client_id=recroom.studio`

#### Password Recovery

| Method | Path | Description |
|--------|------|-------------|
| POST | `/account/recoverpassword` | Forgot password (always returns success) |
| POST | `/account/resetpassword` | Reset via email token |
| POST | `/account/changepassword` | Change password (authenticated) |

#### Role Lookup

| Method | Path | Description |
|--------|------|-------------|
| GET | `/role/:role/:id` | Single role lookup (bare boolean) |
| GET | `/role/:role` | Bulk role lookup (array of IDs) |

### Token Response

```json
{
  "access_token": "eyJ...",
  "expires_in": 3600,
  "token_type": "Bearer",
  "refresh_token": "abc...",
  "scope": "offline_access profile rn rn.accounts ...",
  "key": "8oQ+e+WQaOBPbEcakhqs3dwZZdOmmyDUmJSD9u4AHMY="
}
```

### Implementation Notes

- JWT tokens with RS256 (configurable secret)
- Access token TTL: 1 hour, Refresh token TTL: 7 days
- Game version gating on `ver` parameter (supported/rollout lists)
- Account signup caps per platform ID, IP, device ID
- Ban evasion detection on token issuance
- Staff login audit logging
- Sideloaded Oculus APK support (platform=1, id="1" returns fake cached login)

---

## API (`verse-api.js`)

**Path:** `/api`

### Endpoints

#### Version Check

| Method | Path | Description |
|--------|------|-------------|
| GET | `/versioncheck/v4` | Client version compatibility check |

#### Images

| Method | Path | Description |
|--------|------|-------------|
| GET | `/images/v5/player/:id` | Player images v5 (projected) |
| GET | `/images/v4/player/:id` | Player images v4 (projected) |
| GET | `/images/v3/feed/player/:id` | Player image feed v3 (projected) |
| GET | `/images/v4/room/:roomId` | Room photos (raw SavedImage) |

#### Sanitization

| Method | Path | Description |
|--------|------|-------------|
| POST | `/sanitize/v1/isPure` | Profanity check |

#### Cheers

| Method | Path | Description |
|--------|------|-------------|
| POST | `/PlayerCheer/v1/create` | Create cheer (returns PascalCase envelope) |
| POST | `/PlayerCheer/v1/SetSelectedCheer` | Set selected cheer |
| GET | `/PlayerCheer/v1/GetCheerCounts` | Get cheer counts |

#### Moderation

| Method | Path | Description |
|--------|------|-------------|
| POST | `/PlayerReporting/v1/moderationBlockDetails` | Ban details |
| POST | `/PlayerReporting/v3/voteToKick` | Vote to kick |

#### Chat Reports

| Method | Path | Description |
|--------|------|-------------|
| POST | `/chatreport/createChatReport` | Create chat report (form-encoded) |

#### Relationships

| Method | Path | Description |
|--------|------|-------------|
| POST | `/relationships/v2/sendfriendrequest` | Send friend request |
| POST | `/relationships/v2/acceptfriendrequest` | Accept friend request |

#### Custom Avatar Items

| Method | Path | Description |
|--------|------|-------------|
| GET | `/customAvatarItems/v1/bulk` | Bulk lookup (with unityAssetTarget) |
| GET | `/customAvatarItems/v1/search` | Search items |
| GET | `/customAvatarItems/:id` | Single item |

### Implementation Notes

- Image projection: Player images use `SavedImageId`/`SavedImageType`, room feed uses raw `SavedImage`
- Cheer response uses PascalCase `{Success, Message}` envelope
- Vote-to-kick: `FromPlayerId` = target player, `Data` = plain text reason
- Friend request: Sends `FriendInvite` (type 4) message to target
- Custom avatar items: Quest support via `unityAssetTarget` query param (0=PC, 2=Android)
- Compatible with February 2023 client image/signing expectations

---

## Rooms (`verse-rooms.js`)

**Path:** `/rooms`

### Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/:id` | Optional | Room with subrooms & current saves |
| POST | `/` | Required | Create room |
| PUT | `/:id` | Required (owner) | Update room |
| DELETE | `/:id` | Required (owner) | Delete room |
| POST | `/:id/clone` | Required | Clone room |
| GET | `/:id/subrooms/:sid/data` | Required (owner) | Get subroom save (staged/current) |
| POST | `/:id/subrooms/:sid/data` | Required (owner) | Save subroom (staged or auto-publish) |
| POST | `/:id/subrooms/:sid/publish_save` | Required (owner) | Publish staged save |
| GET | `/:id/saves` | Required (creator/co-owner/in-room) | List saves |
| GET | `/:id/saves/:saveId` | Required | Save details |
| PUT | `/:id/loadscreen` | Required (owner) | Set load screens (replaces array) |
| PUT | `/:id/description` | Required (owner) | Set room description |
| PUT | `/:id/subrooms/:sid/accessibility` | Required (owner) | Set subroom accessibility (enum name) |
| PUT | `/:id/accessibility` | Required (owner) | Set room accessibility (int) |

### Room DTO

```json
{
  "RoomId": 123,
  "Name": "My Room",
  "Description": "A cool room",
  "AccessLevel": 1,
  "CreatorId": 456,
  "CreatedAt": "...",
  "UpdatedAt": "...",
  "ImageName": "",
  "Tags": [],
  "MaxPlayers": 16,
  "IsDorm": false,
  "LoadScreens": [],
  "SubRooms": [{
    "SubRoomId": 1,
    "RoomId": 123,
    "Name": "Main",
    "UnitySceneId": "MainScene",
    "MaxPlayers": 16,
    "CurrentSaveId": 10,
    "StagedSubRoomDataSaveId": null,
    "CreatedAt": "...",
    "UpdatedAt": "...",
    "CurrentSave": { ... }
  }]
}
```

### Save DTO (Room Save Response)

```json
{
  "success": true,
  "error": "",
  "value": {
    "room": { "RoomId": 123 },
    "subRoomDataSave": {
      "SubRoomDataSaveId": 10,
      "SubRoomId": 1,
      "AccountId": 456,
      "Description": "Save comment",
      "DataBlob": "base64...",
      "UnityAsset": "room.unity3d",
      "UnityAssetHash": "sha256...",
      "UnityAsset2": "room_quest.unity3d",
      "UnityAsset2Hash": "sha256...",
      "UnitySubAssets": [],
      "PersistenceVersion": 1,
      "InventionUsage": [],
      "CreatedAt": "..."
    }
  }
}
```

### Implementation Notes

- Room saves are staged by default (`AutoPublish: false`)
- Dorms always auto-publish
- Save history preserved (never overwritten)
- Load screens array - client only uses first entry
- Accessibility: subroom uses enum name (`Private`, `Public`), room uses int
- Subroom save `DataBlob` comes from `CurrentSave.DataBlob`, not flat subroom field
- Compatible with February 2023 client save/publish flow

---

## Matchmaking (`verse-match.js`)

**Path:** `/match`

### Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/matchmake/room/:roomId/:subRoomId` | Required | Matchmake into room |
| POST | `/matchmake/room/:roomId/:subRoomId` | Required | Matchmake (POST form) |
| GET | `/matchmake/quick` | Required | Quick match |
| GET | `/matchmake/random` | Required | Random room |
| POST | `/matchmake/heartbeat` | Required | Presence heartbeat |
| POST | `/matchmake/leave` | Required | Leave room instance |
| GET | `/presence/:accountId` | Optional | Get player presence |
| POST | `/presence/bulk` | Optional | Bulk presence lookup |
| GET | `/photon/config` | Optional | Photon configuration |

### Matchmake Response

```json
{
  "result": 0,
  "errorCode": 0,
  "correlationId": "uuid",
  "roomInstanceId": 123001,
  "roomId": 123,
  "subRoomId": 1,
  "roomInstanceType": 0,
  "location": "MainScene",
  "dataBlob": "base64...",
  "photonRegion": "us",
  "photonRegionId": "us",
  "photonRoomId": "rec.123",
  "name": "^My Room",
  "maxCapacity": 16,
  "isFull": false,
  "isPrivate": false,
  "isInProgress": false,
  "EncryptVoiceChat": false,
  "PhotonAppId": "...",
  "PhotonAppVersion": "1.0",
  "PhotonServer": "ns.exitgames.com",
  "PhotonPort": 4533,
  "PhotonProtocol": "Udp"
}
```

### Result Codes

| Code | Name | Description |
|------|------|-------------|
| 0 | Success | Matchmaking successful |
| 1 | GeneralError | Generic failure |
| 2 | RoomNotFound | Room doesn't exist |
| 3 | RoomFull | Room at capacity |
| 4 | RoomClosed | Room closed |
| 5 | InvalidRoom | Invalid room state |
| 6 | NotAuthorized | Access denied |
| 7 | Banned | Account banned |
| 8 | VersionMismatch | Client version not supported |
| 9 | Maintenance | Server maintenance |

### Implementation Notes

- Always returns published `CurrentSave` (not staged)
- CorrelationId echoed back (required by client)
- Presence heartbeat updates player location
- Orientation room (13) for new players with instance ID -2
- Photon config provided for client connection

---

## Economy (`verse-econ.js`)

**Path:** `/econ`

### Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/storefronts/v4/balance/:type` | Required | Currency balance |
| POST | `/api/storefronts/v4/purchase` | Required | Legacy purchase |
| POST | `/api/items/bulkpurchase` | Required | Bulk purchase (current) |
| GET | `/api/avatar/v2/gifts` | Required | Gift boxes |
| POST | `/api/avatar/v2/gifts/open` | Required | Open gift |
| GET | `/econ/customAvatarItems/v1/owned` | Required | Owned CAI (with unityAssetTarget) |
| GET | `/econ/inventory` | Required | Player inventory |

### Balance Response

```json
{
  "BalanceType": -2,
  "Balance": 1000,
  "CurrencyType": 2
}
```

- `BalanceType` = Platform bucket (always -2 for NonPurchasedNotUsableInP2P)
- `Balance` = Absolute total (not delta)
- Single bucket per currency type

### Bulk Purchase Request

```json
{
  "lines": [
    {
      "ItemType": 0,
      "ItemId": 123,
      "CurrencyType": 2,
      "Price": 100,
      "Quantity": 1,
      "Data": {}
    }
  ]
}
```

### Bulk Purchase Response

```json
{
  "Success": true,
  "BalanceUpdates": [{
    "CurrencyType": 2,
    "BalanceType": -2,
    "Balance": 900,
    "Delta": -100,
    "BalanceAddType": 0,
    "Data": { "ItemId": 123, "Quantity": 1 }
  }],
  "GiftPackage": {
    "AvatarItemType": null,
    "AvatarItemDesc": "",
    "EquipmentPrefabName": "",
    "CustomAvatarItemId": 0,
    "ToPlayerId": 456
  },
  "GiftPackages": [...]
}
```

### Implementation Notes

- Currency types: Tokens=2, Tickets=1, Gold=100, Silver=101
- All balances use platform bucket -2 (ALL_PLATFORMS/NonPurchasedNotUsableInP2P)
- Gift package `AvatarItemType` = null for non-avatar items
- Custom avatar items: ownership via `custom_avatar_item_ownership` table
- Owned CAI includes both purchased and created items
- Quest support via `unityAssetTarget` (0=PC, 2=Android)

---

## Stub Services

The following services are mounted but return only health checks:

- `/cdn` - Content delivery
- `/img` - Image serving  
- `/notify` - Notifications/websockets
- `/leaderboard` - Leaderboards
- `/roomcomments` - Room comments
- `/playersettings` - Player settings
- `/studio` - Rec Room Studio
- `/commerce` - Commerce
- `/datacollection` - Analytics ingestion
- `/discovery` - Service discovery
- `/ai` - AI features
- `/bugreporting` - Bug reports
- `/cards` - Cards
- `/clubs` - Clubs/groups
- `/cms` - CMS
- `/data` - Data
- `/gamelogs` - Game logs
- `/geo` - Geolocation
- `/link` - Account linking
- `/lists` - Lists
- `/moderation` - Moderation
- `/platformnotifications` - Platform notifications
- `/roomieintegrations` - Roomie integrations
- `/storage` - File storage
- `/strings` - Localization strings
- `/strings-cdn` - Strings CDN
- `/thorn` - Thorn
- `/videos` - Videos
- `/www` - Website API

---

## Database Persistence

All data persists in SQLite (`database/recverse.db`):
- Accounts survive server restart
- Room saves are permanent history
- Inventory and balances persistent
- Migrations run automatically on startup

---

## February 2023 Client Compatibility

Key compatibility points verified:
- Service discovery path-based (not subdomain)
- Image projection for player images (SavedImageId/SavedImageType)
- Room feed raw SavedImage format
- Cheer PascalCase envelope
- Vote-to-kick FromPlayerId = target
- Friend request FriendInvite message (type 4)
- Custom avatar item Quest support via unityAssetTarget
- Room save staging/publish flow
- Matchmake always returns published save
- Presence heartbeat with roomInstanceId echo
- OAuth2 grants: password, cached_login, refresh_token, identity_assertion, device_code
- Game version gating on `ver` parameter
- EAC challenge returns `"AA=="`
- Sideloaded Oculus cached login (platform 1, id "1")

---

## Extending Services

To implement a stub service:

1. Create `verse-<service>.js` with Express router
2. Implement endpoints matching RecFlare API
3. Mount in `server.js`
4. Add to `SERVICE_SUBDOMAINS` in `verse-ns.js`
5. Update this documentation
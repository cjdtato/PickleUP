# 🏓 Pickleball Club Platform

> **Play. Improve. Connect. Level Up.**

A **startup-stage web app for pickleball communities** that brings together **open play, clubs, player ratings, matchmaking, coaching, progression, social features, and match history** in one platform.

Instead of using separate tools for finding games, organizing open play, tracking ratings, managing clubs, communicating with players, and working with coaches, this platform aims to put the entire pickleball community experience in one place.

**This is an early-stage product / MVP.**
It is functional and feature-rich, but still actively evolving through real-world use and iteration.

---

## 🚀 What Is This?

The platform is built around a simple loop:

**Find players → Join a club → Play games → Record results → Build your rating → Improve your skills → Connect with the community**

It combines ideas from:

* Club/community platforms
* Open-play management
* Player rating systems
* Coaching platforms
* Social networks
* Gamification and progression systems

The long-term goal is to become a **digital home for pickleball communities**.

---

## ✨ Core Features

### 🏆 Player Ratings

A dedicated doubles rating system designed around actual game performance.

The current rating system uses a **2.000–8.000 scale** and considers:

* Team and opponent ratings
* Expected vs. actual point performance
* Rating reliability
* Partner and opponent variety
* Repeated-group dampening
* Results against unrated players
* Activity and inactivity

The system is designed to reward **accurate competitive performance**, rather than simply counting wins and losses.

A close win and a dominant win do not necessarily have the same rating impact.

New players begin as **NR (Not Rated)** and can receive a provisional estimate through the skill survey or a certified coach.

> **Rating measures competitive ability.**
> **XP, tiers, and badges measure progression and engagement.**

---

### 🎾 Open Play

Players can discover and join organized open-play sessions, while players and hosts can create their own.

Hosts can configure:

* Date and time
* Location
* Price
* Maximum players
* Number of courts
* Games per player
* Casual or Ranked format

When play begins, the platform automatically manages the queue and distributes players across available courts.

The system considers:

* Games already played
* Queue order
* Team balancing
* Available courts
* Player conflicts

Players are never scheduled on two courts simultaneously.

Hosts can also:

* Add courts
* Add games
* Re-randomize the queue
* Correct scores
* Remove games from play
* Manage late payments

### Casual vs. Ranked

**Casual**

Games are recorded but do not affect player ratings.

**Ranked**

Games contribute to player ratings and XP when the session is completed.

---

### 🏠 Clubs

Players and coaches can create and join clubs.

Each club can have:

* Name
* Location
* Description
* Rules
* Members
* Join approval
* Club leaderboard
* Group chat
* Club open plays

Club owners can manage membership and configure how their club operates.

Players can belong to multiple clubs.

Every open play can be associated with a club, creating a direct connection between:

**Club → Community → Open Play → Games → Players**

---

### 👤 Player Profiles

Players have a dedicated profile containing their pickleball identity and history.

Profiles can include:

* Profile picture
* Rating
* Rating history
* Match history
* Clubs
* Skill traits
* Progression
* Results

Players can discover other players through the leaderboard and player directory.

---

### 📊 Match History

Every completed game can become part of a player's personal match history.

Players can review:

* Opponents
* Partners
* Scores
* Results
* Rating changes
* Casual vs. Ranked games
* Historical performance

This creates a persistent record of a player's pickleball journey.

---

### 🧑‍🏫 Coaching & Development

Certified coaches can publish:

* Lessons
* Clinics
* Training sessions
* Homework
* Skill badges

Players can complete a skill survey and track development over time.

Coach verification adds a layer of human validation beyond self-assessment.

The intended progression loop is:

**Assess → Practice → Play → Improve → Get Verified → Level Up**

---

### 🎮 XP, Quests & Progression

The platform includes a gamification layer designed to encourage consistent participation.

Players can earn:

* XP
* Tiers
* Daily quests
* Skill badges
* Coach-verified achievements

XP farming and repeated-group exploitation are controlled through built-in limits and dampening.

Progression is intentionally separate from competitive rating.

---

### 👥 Social Features

Pickleball is highly social, so community interaction is built directly into the platform.

Players can:

* Add friends
* Accept or decline requests
* Send private messages
* Participate in club group chats
* Participate in open-play group chats
* Discover other players
* Track unread messages

The goal is for the platform to become more than a scheduling tool.

**It should help build the community itself.**

---

### 📅 Bookings

Coaches and hosts can publish scheduled sessions.

The platform supports:

* Session calendars
* Capacity limits
* Duration
* Schedule conflict detection
* Upcoming-session reminders
* `.ics` calendar reminders
* Cancellations
* Payment tracking

The system checks for overlapping bookings for both players and coaches.

---

### 💳 Payment Tracking

The current version supports **payment tracking, not payment processing**.

For paid sessions:

1. The player pays the host or coach directly.
2. The player submits the payment reference.
3. The host or coach verifies the payment.
4. The player is marked as paid.
5. Paid players enter the appropriate session queue.

This currently supports GCash and other e-wallet workflows without requiring the platform to handle the actual transaction.

---

### 📱 QR Check-In

Check-in is per event, not per facility. There is no front-desk tablet.

**Open play**

* The host opens their open play and taps **Show check-in code**. A QR code and an 8-character code appear on the host's phone and change every minute.
* Players who joined scan it with their camera (or type the code). Only players who **paid and checked in** are put into games; the host is always checked in.
* If a phone can't scan, the host can tap **Check in** next to a player.
* When someone is done playing, the host taps **Check out** next to them. Their waiting games are removed, their finished games still count, and they can scan the code again to come back. (A player on a court can be checked out once that game is scored or removed.)
* Check-in opens 2 hours before the start. Open plays created before this feature keep the old paid-only rule.

**Coach bookings**

* The coach taps **Check-in code** next to a session (Coach tab). Booked players scan it (or type it) and are checked in for +40 XP, the same result as the coach tapping **Check in**. The coach's manual **Check in** button still works as a fallback.
* Check-in opens 2 hours before the session and closes 4 hours after it starts.

Codes are tied to one open play or session, stay valid for about 3 minutes, and a player is locked out for 15 minutes after 10 wrong codes.

---

## 🧠 Skill System

New players complete a **6-trait skill survey** to establish an initial player profile.

The survey is intentionally separate from the competitive rating.

It helps the platform understand where a player currently sees themselves across different aspects of their game.

The resulting profile can be used as a starting point for development and coaching.

Players can retake the assessment periodically.

---

# 🛡️ Built for Real Usage

Although this is a startup-stage application, the platform is designed with real multi-user usage in mind.

### Authentication

* Server-side password hashing using `scrypt`
* Login rate limiting
* Account disabling
* Password reset
* Session management
* Optional Google Sign-In
* Reserved username protection
* Sign-up rate limiting

### Data Integrity

Shared records use optimistic **compare-and-swap** writes with automatic retries.

This helps prevent race conditions such as:

* Double bookings
* Duplicate usernames
* Double XP
* Lost updates
* Duplicate match processing
* Lost invite tokens

Match results are designed to be applied by exactly one request.

### Application Security

The application also uses:

* Content Security Policy
* HSTS
* Permissions Policy
* Input validation
* Rate limiting
* Destructive-action confirmations
* Double-submit protection
* Secure session handling

---

# ⚡ Performance & Reliability

The application includes several optimizations intended to keep the experience responsive as usage increases.

These include:

* Reduced unnecessary data reads
* Shared in-flight lookups
* Adaptive polling
* Client-side render optimization
* Offline-aware polling
* Service-worker caching controls
* Race-free session initialization
* Concurrency-safe writes

The architecture remains intentionally lightweight for a startup-stage product.

---

# 🧪 Testing

The project includes automated tests covering the major API and UI workflows.

```bash
npm install
npm test
```

The test suite currently covers areas including:

* Authentication
* Ranked play
* Rating and scoring
* Match disputes
* Coaching
* Bookings
* Quests
* Open play
* Clubs
* Social features
* Concurrency
* UI smoke tests

Tests use an in-memory Netlify Blobs mock, so the core scenarios can be tested without requiring a live Netlify account.

---

# 🏗️ Technology

The application is intentionally built as a lightweight web platform.

| Layer          | Technology            |
| -------------- | --------------------- |
| Frontend       | HTML, CSS, JavaScript |
| Backend        | Netlify Functions     |
| Data           | Netlify Blobs         |
| Authentication | Server-side sessions  |
| Hosting        | Netlify               |
| Source Control | GitHub                |
| Testing        | Node.js, jsdom        |

The application can be deployed directly through GitHub and Netlify.

---

# ⚙️ Deployment

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Required:

```text
ADMIN_PASSWORD
```

Optional:

```text
SESSION_SECRET
GOOGLE_CLIENT_ID
```

### 3. Deploy

Push the project to GitHub and connect the repository to Netlify.

The application will use Netlify Functions and Netlify Blobs for its backend and persistent data.

---

# 🔐 Admin & Club Management

Administrators can configure the platform through the admin interface, including:

* Courts
* Facility settings
* Geofence
* Coaches
* User roles
* Check-in
* User management

The platform uses three primary roles:

* **Player**
* **Certified Coach**
* **Admin**

---

# 📈 Product Philosophy

This project is intentionally being built as a **startup MVP rather than a finished enterprise product**.

The priority is not to build every possible feature before anyone uses it.

The priority is:

> **Build → Launch → Let players use it → Learn → Improve → Repeat**

The current feature set provides enough of the core ecosystem to begin validating how real pickleball communities organize, play, compete, communicate, and improve.

Some features will change.

Some will be removed.

Some will become much more important than originally expected.

That is part of building an early-stage product.

---

# 🗺️ What's Next?

The platform has a foundation for expanding into areas such as:

* Tournament management
* Advanced player analytics
* Automated payment processing
* More powerful coaching tools
* Club subscriptions
* Venue management
* Native mobile applications
* Improved matchmaking
* Regional leaderboards
* National rankings
* Community discovery
* Advanced player development

These are directions rather than promises.

The immediate objective is **real-world validation and adoption**.

---

# 🎯 The Vision

Pickleball is more than a sport.

It's a network of players, clubs, coaches, courts, games, competitions, friendships, and communities.

The vision of this platform is to connect all of those pieces.

### From finding your next game...

### to becoming a better player.

### From joining a club...

### to building a community.

### From playing your first match...

### to knowing exactly how far you've come.

**Play. Improve. Connect. Level Up.**

---

## 🚧 Project Status

**Startup / Early MVP — Actively Developing**

The platform is functional, but it is still under active development and should be considered an evolving product rather than a production-scale commercial service.

Features, architecture, rating logic, and user experience may continue to change as the product is tested with real players and communities.

---

## 📄 Documentation

Detailed engineering notes, version history, security audits, and implementation changes are maintained separately from this README.

For the main product experience, start with the application itself.

<div align="center">

  # 🍽️ ForkFleet
  **The Next-Generation, Multi-Restaurant Food Delivery Ecosystem**

  [![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](#)
  [![PostgreSQL](https://img.shields.io/badge/PostgreSQL-316192?style=for-the-badge&logo=postgresql&logoColor=white)](#)
  [![Redis](https://img.shields.io/badge/Redis-DC382D?style=for-the-badge&logo=redis&logoColor=white)](#)
  [![JavaScript](https://img.shields.io/badge/Vanilla_JS-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)](#)
  [![License](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](#)

  > *Current delivery giants force you to choose one restaurant per order. ForkFleet shatters that limitation. We've engineered a true **Multi-Restaurant Cart** backed by an atomic order-splitting engine, allowing users to build a single feast from multiple kitchens with one checkout.*

</div>

---

## 🚀 The Vision & The Edge
**The Problem:** Group orders are a logistical nightmare. If three friends want sushi, burgers, and tacos, they have to place three separate orders, pay three delivery fees, and track three different riders.
**The ForkFleet Solution:** A "food court in an app." Our backend infrastructure handles the complex routing of splitting a single payment into micro-transactions, dispatching independent prep alerts to multiple kitchens, and syncing it all to a unified live-tracking UI for the customer.

---

## ✨ Ecosystem Features

### 🛒 1. The Smart Customer App
* **Universal Cart:** Mix and match items from completely different restaurants.
* **Intelligent Fee Calculation:** Dynamic delivery pricing based on cross-restaurant routing.
* **Unified Live Tracking:** Watch multiple sub-orders progress independently (Preparing → Ready) before converging for delivery.

### 🍳 2. The Restaurant Dashboard
* **Real-Time Kanban Queue:** Instant WebSocket-powered order injection (New → Preparing → Ready).
* **Live Menu Management:** Toggle item availability instantly; syncs globally without page reloads.
* **Financial Analytics:** Track gross revenue, commissions, and net payouts dynamically.

### 🛵 3. The Rider PWA (Progressive Web App)
* **Offline-First Architecture:** Service Workers ensure the app functions even when moving through cellular dead zones.
* **Smart Routing:** Interactive maps with sequenced pickups for multi-restaurant orders.
* **Secure Handoff:** 4-digit OTP verification ensures the right food gets to the right customer.

---

## 🏗️ System Architecture

ForkFleet is structured as a decoupled monorepo. The core engineering challenge—the **Order Splitting Engine**—is handled by our Node.js microservices.

```mermaid
graph TD;
    Customer[Customer Checkout] -->|1 Payment| API(Node.js / Express API);
    API -->|Transaction Lock| DB[(PostgreSQL Core)];
    API -->|Pub/Sub| Redis[(Redis Cache)];
    Redis -->|WebSocket| Dash1[Restaurant A Dashboard];
    Redis -->|WebSocket| Dash2[Restaurant B Dashboard];
    API -->|Assign Route| Rider[Rider PWA];

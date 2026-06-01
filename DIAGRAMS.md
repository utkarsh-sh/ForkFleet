# ForkFleet — Flow Diagrams

Paste any of these into GitHub issues, PRs, or your README.
GitHub renders Mermaid natively in markdown files.

---

## 1. Order Splitting Flow

```mermaid
sequenceDiagram
    participant C as 🛒 Customer App
    participant API as ⚙️ Backend API
    participant OSE as ⚡ Order Splitting Engine
    participant DB as 🗄️ PostgreSQL
    participant RZP as 💳 Razorpay
    participant WS as 🔔 WebSocket
    participant R1 as 🍛 Restaurant A
    participant R2 as 🍕 Restaurant B

    C->>API: POST /orders (multi-restaurant cart)
    API->>OSE: splitOrder(cartItems)
    OSE->>DB: BEGIN TRANSACTION
    OSE->>DB: INSERT INTO orders (parent)
    OSE->>DB: INSERT INTO sub_orders × 2 (per restaurant)
    OSE->>DB: INSERT INTO order_items (each item)
    OSE->>DB: INSERT INTO delivery_jobs
    OSE->>DB: COMMIT
    OSE->>RZP: orders.create(grandTotal)
    RZP-->>OSE: razorpay_order_id
    OSE->>DB: clear Redis cart
    OSE->>WS: publishOrderEvent('order_created')
    WS-->>R1: 🔔 New sub-order notification
    WS-->>R2: 🔔 New sub-order notification
    API-->>C: { razorpay_order_id, key_id }

    Note over C,RZP: Razorpay checkout modal opens

    C->>RZP: Customer pays (UPI/Card)
    RZP-->>C: { razorpay_payment_id, signature }
    C->>API: POST /payments/verify (signature)
    API->>API: verifyPaymentSignature() — timingSafeEqual
    API->>DB: UPDATE payments → captured
    API->>DB: UPDATE orders → confirmed
    API->>DB: INSERT INTO restaurant_payouts × 2
    API->>RZP: Route transfer → Restaurant A (async)
    API->>RZP: Route transfer → Restaurant B (async)
    API->>WS: publishOrderEvent('payment_confirmed')
    WS-->>C: ✅ Order confirmed
    WS-->>R1: 💰 Payment confirmed — start cooking
    WS-->>R2: 💰 Payment confirmed — start cooking
```

---

## 2. Real-Time Delivery Tracking

```mermaid
sequenceDiagram
    participant R1 as 🍛 Restaurant A Dashboard
    participant API as ⚙️ Backend API
    participant Redis as 📡 Redis Pub/Sub
    participant WS as 🔔 Socket.IO
    participant C as 🛒 Customer App
    participant Rider as 🛵 Rider App

    R1->>API: PATCH /sub-orders/:id/status {status: "ready"}
    API->>Redis: PUBLISH order:FF-20481 {event: sub_order_status_updated}
    Redis->>WS: psubscribe callback fires
    WS->>C: emit('order_update', {restaurant: "Bukhara", status: "ready"})
    Note over C: Tracking screen updates in <200ms

    API->>API: findNearestRider() via Redis GEORADIUS
    API->>Rider: push job card (multi-stop)
    Rider->>API: POST /riders/jobs/:id/accept
    API->>Redis: PUBLISH order:FF-20481 {event: rider_assigned}
    WS->>C: emit('order_update', {event: "rider_assigned"})

    loop Every 5 seconds while delivering
        Rider->>API: PATCH /riders/location {lat, lng}
        API->>Redis: GEORADIUS update
        API->>Redis: PUBLISH rider:{id} {event: rider_location_updated}
        WS->>C: emit('order_update', {lat, lng})
        Note over C: Live GPS dot moves on map
    end

    Rider->>API: PATCH /riders/jobs/:id/stop {state: "dropped", otp: "2847"}
    API->>API: Verify OTP
    API->>DB: UPDATE delivery_jobs → completed
    API->>Redis: PUBLISH order:FF-20481 {event: order_delivered}
    WS->>C: emit('order_update', {event: "delivered"}) 🎉
```

---

## 3. Razorpay Webhook Idempotency

```mermaid
flowchart TD
    RZP[Razorpay Server] -->|POST /payments/webhook| WH[Webhook Handler]
    WH --> SIG{Validate\nHMAC Signature}
    SIG -->|Invalid| R400[Return 400 Bad Request]
    SIG -->|Valid| PARSE[Parse JSON body]
    PARSE --> IDEM{Event already\nin webhook_events?}
    IDEM -->|Yes - duplicate| R200A[Return 200 already_processed]
    IDEM -->|No - new event| DISPATCH[Dispatch to handler]
    DISPATCH --> E1{Event type?}
    E1 -->|payment.captured| H1[handlePaymentCaptured\nconfirmPayment + Route splits]
    E1 -->|payment.failed| H2[handlePaymentFailed\nmark payment failed]
    E1 -->|refund.processed| H3[handleRefundProcessed\nupdate payment status]
    E1 -->|transfer.settled| H4[handleTransferSettled\nmark payout paid]
    H1 & H2 & H3 & H4 --> MARK[INSERT webhook_events\nstatus = processed]
    MARK --> R200B[Return 200 ok]

    style RZP fill:#1a1916,stroke:#f0a020
    style SIG fill:#1a2535,stroke:#e8522a
    style IDEM fill:#1a2535,stroke:#4090e0
    style R400 fill:#2a1a1a,stroke:#dc382d
    style R200A fill:#1a2a1a,stroke:#2ecc71
    style R200B fill:#1a2a1a,stroke:#2ecc71
```

---

## 4. System Component Map

```mermaid
graph TD
    subgraph "Client Layer"
        CA["📱 Customer App\nHTML/CSS/JS"]
        RD["🍳 Restaurant Dashboard\nHTML/CSS/JS"]
        RA["🛵 Rider PWA\nPWA + Service Worker"]
        RZP_SDK["💳 Razorpay SDK\nCheckout Widget"]
    end

    subgraph "API Layer :4000"
        EX["Express.js Server"]
        subgraph "Routes"
            AUTH["/auth"]
            CART["/cart"]
            ORD["/orders"]
            PAY["/payments"]
            REST["/restaurants"]
            RID["/riders"]
        end
        subgraph "Services"
            OSE["⚡ Order Splitting Engine\nAtomic transactions"]
            RZP_SVC["💳 Razorpay Service\nHMAC + Route"]
            WH["🔔 Webhook Handler\nIdempotent"]
        end
        WSIO["Socket.IO Server"]
    end

    subgraph "Data Layer"
        PG[("🗄️ PostgreSQL 15\n13 tables")]
        RD_DB[("📡 Redis 7\nCache + Pub/Sub")]
        RZP_API["💳 Razorpay API"]
        NOM["🗺 Nominatim\nGeocoding"]
    end

    CA -->|REST| EX
    RD -->|REST| EX
    RA -->|REST| EX
    RZP_SDK -->|verify| PAY
    EX --> AUTH & CART & ORD & PAY & REST & RID
    ORD --> OSE
    PAY --> RZP_SVC
    PAY --> WH
    OSE --> PG
    OSE --> RD_DB
    RZP_SVC --> RZP_API
    WSIO <-->|Pub/Sub| RD_DB
    WSIO -->|events| CA & RD & RA
    CA -->|GPS| NOM
```

---

## 5. Database Entity Relationships

```mermaid
erDiagram
    USERS {
        uuid id PK
        string name
        string phone
        string email
        string password_hash
        string role
    }
    RESTAURANTS {
        uuid id PK
        uuid owner_id FK
        string name
        string[] cuisine_tags
        decimal latitude
        decimal longitude
        string razorpay_account_id
    }
    MENU_ITEMS {
        uuid id PK
        uuid restaurant_id FK
        uuid category_id FK
        string name
        integer price_paise
        boolean is_veg
        boolean is_available
    }
    ORDERS {
        uuid id PK
        uuid customer_id FK
        string status
        integer grand_total_paise
        integer restaurant_count
        timestamptz created_at
    }
    SUB_ORDERS {
        uuid id PK
        uuid order_id FK
        uuid restaurant_id FK
        string status
        integer subtotal_paise
    }
    ORDER_ITEMS {
        uuid id PK
        uuid sub_order_id FK
        uuid menu_item_id FK
        integer price_paise
        integer quantity
    }
    PAYMENTS {
        uuid id PK
        uuid order_id FK
        string razorpay_order_id
        string razorpay_payment_id
        integer amount_paise
        string status
        string method
    }
    RESTAURANT_PAYOUTS {
        uuid id PK
        uuid sub_order_id FK
        uuid payment_id FK
        integer amount_paise
        decimal commission_pct
        integer net_amount_paise
        string razorpay_transfer_id
        string status
    }
    DELIVERY_JOBS {
        uuid id PK
        uuid order_id FK
        uuid rider_id FK
        jsonb pickup_sequence
        string status
    }
    WEBHOOK_EVENTS {
        uuid id PK
        string razorpay_event_id UK
        string event_type
        string status
    }

    USERS ||--o{ ORDERS : "places"
    USERS ||--o{ RESTAURANTS : "owns"
    RESTAURANTS ||--o{ MENU_ITEMS : "has"
    ORDERS ||--|{ SUB_ORDERS : "split into"
    SUB_ORDERS ||--|{ ORDER_ITEMS : "contains"
    SUB_ORDERS ||--o{ RESTAURANT_PAYOUTS : "generates"
    ORDERS ||--o{ PAYMENTS : "paid via"
    ORDERS ||--o{ DELIVERY_JOBS : "assigned"
    MENU_ITEMS ||--o{ ORDER_ITEMS : "referenced in"
```

---

## 6. Revenue Flow

```mermaid
flowchart LR
    C["Customer\npays ₹820"]
    RZP["Razorpay\nprocesses"]
    FF["ForkFleet\nplatform"]
    RA["Restaurant A\ngets paid"]
    RB["Restaurant B\ngets paid"]

    C -->|"₹820\ngrand total"| RZP
    RZP -->|"₹820 captured"| FF
    FF -->|"₹369 net\n(₹430 - 15%)"| RA
    FF -->|"₹310 net\n(₹365 - 15%)"| RB
    FF -->|"₹141 stays\n(commission + delivery)"| FF

    note1["Platform keeps:\n₹123 commission (15%)\n₹60 delivery (2×₹30)\n₹41 GST collected"]

    style C fill:#1a2535,stroke:#4090e0
    style RZP fill:#1a1a0e,stroke:#f0a020
    style FF fill:#2a1508,stroke:#e8522a
    style RA fill:#0e2a1a,stroke:#2ecc71
    style RB fill:#0e2a1a,stroke:#2ecc71
```

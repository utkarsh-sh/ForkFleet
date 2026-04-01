<div align="center">
  
  # 🍽️ ForkFleet
  **The Multi-Restaurant Food Delivery Ecosystem**
  
  [![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](#)
  [![PostgreSQL](https://img.shields.io/badge/PostgreSQL-316192?style=for-the-badge&logo=postgresql&logoColor=white)](#)
  [![Redis](https://img.shields.io/badge/Redis-DC382D?style=for-the-badge&logo=redis&logoColor=white)](#)
  [![Vanilla JS](https://img.shields.io/badge/Vanilla_JS-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)](#)

  > *Why limit customers to one restaurant per order? ForkFleet flips the traditional delivery model by introducing a true **Multi-Restaurant Cart** powered by an atomic order-splitting backend engine.*

</div>

---

## 📱 See it in Action

*(Pro-Tip: Record 5-second screen recordings of your apps and drop the `.gif` files here!)*

| Customer Ordering App | Restaurant Dashboard | Rider PWA (Live Tracking) |
| :---: | :---: | :---: |
| <img src="https://via.placeholder.com/300x500.png?text=Drop+Customer.gif+Here" width="250"/> | <img src="https://via.placeholder.com/400x250.png?text=Drop+Dashboard.gif+Here" width="350"/> | <img src="https://via.placeholder.com/300x500.png?text=Drop+Rider.gif+Here" width="250"/> |
| Multi-cart merging & live tracking | Real-time kanban & kitchen queues | GPS routing & OTP delivery confirmation |

---

## ✨ The Core Differentiator
Most delivery apps (like Swiggy or Zomato) restrict carts to a single kitchen to simplify logistics. **ForkFleet solves the multi-kitchen routing problem:**
1. **Unified Checkout:** Customers pay once via Razorpay/Stripe.
2. **Order Splitting Engine:** The backend instantly splits the parent order into sub-orders for each respective kitchen.
3. **Parallel Fulfillment:** Kitchens prepare food simultaneously, while Redis coordinates live WebSocket updates back to the customer.

---

## 🛠️ System Architecture & Tech Stack

The ecosystem consists of three decoupled frontend clients communicating with a centralized Node.js API.

* **Backend Engine:** Node.js, Express.js
* **Primary Database:** PostgreSQL (ACID compliance for order transactions)
* **Real-time & Caching:** Redis (Live cart sessions, Geolocation indexing, WebSocket Pub/Sub)
* **Frontend Clients:** * Vanilla HTML/CSS/JS (Zero-bloat, DOM manipulation)
  * Service Workers (Offline support for Rider PWA)

---

## 🚦 Interactive Setup Guide

<details>
<summary><b>🔥 1. Booting up the Backend</b> (Click to expand)</summary>

1. Navigate to the backend directory:
   ```bash
   cd backend

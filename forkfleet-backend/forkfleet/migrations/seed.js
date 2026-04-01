require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'forkfleet',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
});

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── Owner users ────────────────────────────────────────────────────────────
    const hash = await bcrypt.hash('password123', 12);
    const ownerIds = [];
    for (const phone of ['+919900000001', '+919900000002', '+919900000003']) {
      const { rows } = await client.query(
        `INSERT INTO users (phone, name, role, password_hash)
         VALUES ($1, $2, 'restaurant_owner', $3)
         ON CONFLICT (phone) DO UPDATE SET name=EXCLUDED.name
         RETURNING id`, [phone, `Owner ${phone.slice(-4)}`, hash]
      );
      ownerIds.push(rows[0].id);
    }

    // ── Test customer ──────────────────────────────────────────────────────────
    const { rows: [customer] } = await client.query(
      `INSERT INTO users (phone, name, role, password_hash)
       VALUES ('+919800000001','Arjun Mehta','customer',$1)
       ON CONFLICT (phone) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [hash]
    );
    console.log('Test customer phone: +919800000001 / password: password123');

    // ── Restaurants + menus ───────────────────────────────────────────────────
    const restaurants = [
      {
        ownerId: ownerIds[0], name: 'Bukhara Tandoor', cuisine: ['north-indian'],
        address: '12 Connaught Place', city: 'Delhi', pincode: '110001',
        lat: 28.6304, lng: 77.2177, phone: '+911100000001',
        categories: [
          { name: 'Mains', items: [
            { name:'Butter Chicken',  desc:'Slow-cooked in rich tomato gravy', price:320, veg:false },
            { name:'Dal Makhani',     desc:'Overnight simmered black lentils', price:240, veg:true  },
            { name:'Lamb Rogan Josh', desc:'Kashmiri spiced slow-cook',        price:380, veg:false },
            { name:'Paneer Makhani',  desc:'Cottage cheese in tomato gravy',   price:290, veg:true  },
          ]},
          { name: 'Breads', items: [
            { name:'Garlic Naan',   desc:'Tandoor-baked with butter',  price: 60, veg:true },
            { name:'Lachha Paratha',desc:'Flaky whole-wheat flatbread', price: 50, veg:true },
          ]},
        ],
      },
      {
        ownerId: ownerIds[1], name: 'Dragon Palace', cuisine: ['chinese'],
        address: '45 Hauz Khas Village', city: 'Delhi', pincode: '110016',
        lat: 28.5535, lng: 77.2012, phone: '+911100000002',
        categories: [
          { name: 'Rice & Noodles', items: [
            { name:'Veg Fried Rice',     desc:'Wok-tossed with seasonal veg',   price:180, veg:true  },
            { name:'Schezwan Noodles',   desc:'Fiery hand-pulled wheat noodles', price:200, veg:true  },
            { name:'Chicken Chow Mein',  desc:'Classic stir-fried noodles',      price:220, veg:false },
          ]},
          { name: 'Starters', items: [
            { name:'Spring Rolls (6 pcs)',    desc:'Golden fried, served with chilli',   price:140, veg:true  },
            { name:'Chicken Manchurian',      desc:'Crispy in spicy Manchurian sauce',   price:260, veg:false },
            { name:'Veg Dimsums (8 pcs)',     desc:'Steamed with ginger-garlic',         price:180, veg:true  },
          ]},
        ],
      },
      {
        ownerId: ownerIds[2], name: 'Pizza Rustica', cuisine: ['italian', 'pizza'],
        address: '7 Khan Market', city: 'Delhi', pincode: '110003',
        lat: 28.5998, lng: 77.2275, phone: '+911100000003',
        categories: [
          { name: 'Pizzas', items: [
            { name:'Margherita',      desc:'San Marzano tomato, fior di latte', price:299, veg:true  },
            { name:'BBQ Chicken',     desc:'Smoked chicken, caramelised onion', price:399, veg:false },
            { name:'Truffle Funghi',  desc:'Wild mushroom, truffle oil, rocket',price:449, veg:true  },
            { name:'Diavola',         desc:'Spicy salami, jalapeño, ricotta',   price:420, veg:false },
          ]},
          { name: 'Sides', items: [
            { name:'Garlic Breadsticks', desc:'Fresh rosemary, sea salt',          price:120, veg:true },
            { name:'Caesar Salad',       desc:'Romaine, parmesan, house dressing', price:180, veg:true },
          ]},
        ],
      },
    ];

    for (const r of restaurants) {
      const { rows: [rest] } = await client.query(
        `INSERT INTO restaurants (owner_id, name, cuisine_tags, address, city, pincode, latitude, longitude, phone, avg_rating, total_ratings)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,${(4.0 + Math.random()).toFixed(1)},${Math.floor(100+Math.random()*500)})
         ON CONFLICT DO NOTHING RETURNING id`,
        [r.ownerId, r.name, r.cuisine, r.address, r.city, r.pincode, r.lat, r.lng, r.phone]
      );
      if (!rest) continue;

      for (const [ci, cat] of r.categories.entries()) {
        const { rows:[category] } = await client.query(
          `INSERT INTO menu_categories (restaurant_id, name, sort_order) VALUES ($1,$2,$3) RETURNING id`,
          [rest.id, cat.name, ci]
        );
        for (const [ii, item] of cat.items.entries()) {
          await client.query(
            `INSERT INTO menu_items (restaurant_id, category_id, name, description, price, is_veg, sort_order)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [rest.id, category.id, item.name, item.desc, item.price, item.veg, ii]
          );
        }
      }
      console.log(`  ✓ Seeded: ${r.name}`);
    }

    await client.query('COMMIT');
    console.log('\nSeed complete.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();

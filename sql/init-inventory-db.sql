CREATE DATABASE IF NOT EXISTS ecommerce_inventory_db;
USE ecommerce_inventory_db;

CREATE TABLE IF NOT EXISTS inventory_items (
    inventory_id INT AUTO_INCREMENT PRIMARY KEY,

    variant_id INT NOT NULL UNIQUE,
    product_id INT NOT NULL,

    quantity_on_hand INT NOT NULL DEFAULT 0,
    quantity_reserved INT NOT NULL DEFAULT 0,
    quantity_sold INT NOT NULL DEFAULT 0,
    is_active TINYINT(1) NOT NULL DEFAULT 1,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CHECK (quantity_on_hand >= 0),
    CHECK (quantity_reserved >= 0),
    CHECK (quantity_sold >= 0),
    CHECK (quantity_reserved <= quantity_on_hand)
);

CREATE TABLE IF NOT EXISTS inventory_movements (
    movement_id INT AUTO_INCREMENT PRIMARY KEY,

    variant_id INT NOT NULL,
    movement_type ENUM(
        'INIT',
        'ADMIN_ADJUST',
        'RESERVE',
        'RELEASE',
        'COMMIT',
        'SOLD'
    ) NOT NULL,

    quantity INT NOT NULL,
    reference_type VARCHAR(50) NULL,
    reference_id VARCHAR(100) NULL,
    note TEXT NULL,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
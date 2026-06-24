require('dotenv').config();

const express = require('express');
const mysql = require('mysql2/promise');
const { CognitoJwtVerifier } = require('aws-jwt-verify');

const app = express();
app.use(express.json());

// 1. MySQL Pool
const dbPool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME, // ecommerce_inventory_db
    waitForConnections: true,
    connectionLimit: 10
});

// 2. Cognito JWT Verifier
const verifier = CognitoJwtVerifier.create({
    userPoolId: process.env.COGNITO_USER_POOL_ID,
    tokenUse: "access",
    clientId: process.env.COGNITO_APP_CLIENT_ID
});

// ========================================================================
// HELPER
// ========================================================================
function normalizePositiveInt(value, fieldName) {
    const numberValue = Number(value);

    if (!Number.isInteger(numberValue) || numberValue <= 0) {
        throw new Error(`${fieldName} không hợp lệ!`);
    }

    return numberValue;
}

function normalizeNonNegativeInt(value, fieldName) {
    const numberValue = Number(value);

    if (!Number.isInteger(numberValue) || numberValue < 0) {
        throw new Error(`${fieldName} không hợp lệ!`);
    }

    return numberValue;
}

function normalizeItems(items) {
    if (!Array.isArray(items) || items.length === 0) {
        throw new Error("Danh sách items không được để trống!");
    }

    const normalized = [];

    for (const item of items) {
        normalized.push({
            variantId: normalizePositiveInt(item.variantId, "variantId"),
            productId: item.productId !== undefined && item.productId !== null
                ? normalizePositiveInt(item.productId, "productId")
                : null,
            quantity: normalizePositiveInt(item.quantity, "quantity")
        });
    }

    return normalized;
}

async function getInventoryByVariantIds(variantIds) {
    if (!Array.isArray(variantIds) || variantIds.length === 0) {
        return [];
    }

    const cleanVariantIds = [...new Set(
        variantIds
            .map(id => Number(id))
            .filter(id => Number.isInteger(id) && id > 0)
    )];

    if (cleanVariantIds.length === 0) {
        return [];
    }

    const placeholders = cleanVariantIds.map(() => "?").join(",");

    const [rows] = await dbPool.execute(
        `
        SELECT
            inventory_id,
            variant_id,
            product_id,
            quantity_on_hand,
            quantity_reserved,
            quantity_sold,
            GREATEST(quantity_on_hand - quantity_reserved, 0) AS quantity_available,
            created_at,
            updated_at
        FROM inventory_items
        WHERE variant_id IN (${placeholders})
          AND is_active = 1
        `,
        cleanVariantIds
    );

    return rows;
}

async function insertMovement(connection, {
    variantId,
    movementType,
    quantity,
    referenceType = null,
    referenceId = null,
    note = null
}) {
    await connection.execute(
        `
        INSERT INTO inventory_movements (
            variant_id,
            movement_type,
            quantity,
            reference_type,
            reference_id,
            note
        )
        VALUES (?, ?, ?, ?, ?, ?)
        `,
        [
            variantId,
            movementType,
            quantity,
            referenceType,
            referenceId,
            note
        ]
    );
}

// ========================================================================
// AUTH MIDDLEWARE
// ========================================================================
async function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            error: "Không tìm thấy Token. Vui lòng đăng nhập!"
        });
    }

    const token = authHeader.split(' ')[1];

    try {
        const payload = await verifier.verify(token);

        req.user = {
            sub: payload.sub,
            username: payload.username || payload["cognito:username"] || payload.sub,
            groups: payload["cognito:groups"] || []
        };

        next();
    } catch (error) {
        console.error("Lỗi verify token tại Inventory Service:", error);

        return res.status(401).json({
            error: "Token không hợp lệ hoặc đã hết hạn!"
        });
    }
}

function adminMiddleware(req, res, next) {
    const groups = req.user.groups || [];

    if (!groups.includes("Admin")) {
        return res.status(403).json({
            error: "Quyền truy cập bị từ chối! Bạn không phải Admin."
        });
    }

    next();
}

function internalMiddleware(req, res, next) {
    const apiKey = req.headers["x-internal-api-key"];

    if (!process.env.INTERNAL_API_KEY) {
        return res.status(500).json({
            error: "Inventory Service chưa cấu hình INTERNAL_API_KEY!"
        });
    }

    if (!apiKey || apiKey !== process.env.INTERNAL_API_KEY) {
        return res.status(403).json({
            error: "Không có quyền gọi internal Inventory API!"
        });
    }

    next();
}

// ========================================================================
// ROUTE MỞ: LẤY TỒN KHO THEO 1 VARIANT
// ========================================================================
app.get('/api/inventory/variants/:variantId', async (req, res) => {
    const { variantId } = req.params;

    try {
        const inventories = await getInventoryByVariantIds([variantId]);

        if (inventories.length === 0) {
            return res.status(404).json({
                error: "Không tìm thấy tồn kho của biến thể này!"
            });
        }

        return res.json({
            message: "Lấy tồn kho biến thể thành công!",
            inventory: inventories[0]
        });

    } catch (error) {
        console.error("Lỗi lấy tồn kho variant:", error);

        return res.status(500).json({
            error: "Không thể lấy tồn kho biến thể!"
        });
    }
});

// ========================================================================
// ROUTE MỞ: LẤY TỒN KHO THEO NHIỀU VARIANT
// Body: { "variantIds": [1, 2, 3] }
// ========================================================================
app.post('/api/inventory/variants/batch', async (req, res) => {
    const { variantIds } = req.body || {};

    if (!Array.isArray(variantIds)) {
        return res.status(400).json({
            error: "variantIds phải là một mảng!"
        });
    }

    try {
        const inventories = await getInventoryByVariantIds(variantIds);

        return res.json({
            message: "Lấy tồn kho danh sách biến thể thành công!",
            inventories
        });

    } catch (error) {
        console.error("Lỗi lấy tồn kho batch:", error);

        return res.status(500).json({
            error: "Không thể lấy tồn kho danh sách biến thể!"
        });
    }
});

// ========================================================================
// ROUTE MỞ: LẤY TỔNG TỒN KHO / ĐÃ BÁN THEO NHIỀU PRODUCT
// Body: { "productIds": [1, 2, 3] }
// ========================================================================
app.post('/api/inventory/products/summary', async (req, res) => {
    const { productIds } = req.body || {};

    if (!Array.isArray(productIds)) {
        return res.status(400).json({
            error: "productIds phải là một mảng!"
        });
    }

    const cleanProductIds = [...new Set(
        productIds
            .map(id => Number(id))
            .filter(id => Number.isInteger(id) && id > 0)
    )];

    if (cleanProductIds.length === 0) {
        return res.json({
            message: "Lấy summary inventory thành công!",
            summaries: []
        });
    }

    try {
        const placeholders = cleanProductIds.map(() => "?").join(",");

        const [rows] = await dbPool.execute(
            `
            SELECT
                product_id,
                COALESCE(SUM(quantity_on_hand), 0) AS quantity_on_hand,
                COALESCE(SUM(quantity_reserved), 0) AS quantity_reserved,
                COALESCE(SUM(quantity_sold), 0) AS quantity_sold,
                GREATEST(
                    COALESCE(SUM(quantity_on_hand), 0) - COALESCE(SUM(quantity_reserved), 0),
                    0
                ) AS quantity_available
            FROM inventory_items
            WHERE product_id IN (${placeholders})
                AND is_active = 1
            GROUP BY product_id
            `,
            cleanProductIds
        );

        return res.json({
            message: "Lấy summary inventory thành công!",
            summaries: rows
        });

    } catch (error) {
        console.error("Lỗi lấy inventory summary theo product:", error);

        return res.status(500).json({
            error: "Không thể lấy inventory summary theo product!"
        });
    }
});

// ========================================================================
// ROUTE ADMIN: TẠO HOẶC CẬP NHẬT TỒN KHO BAN ĐẦU CHO VARIANT
// Body: { variantId, productId, quantityOnHand }
// ========================================================================
app.post('/api/inventory/admin/items', authMiddleware, adminMiddleware, async (req, res) => {
    const { variantId, productId, quantityOnHand } = req.body || {};

    let cleanVariantId;
    let cleanProductId;
    let cleanQuantityOnHand;

    try {
        cleanVariantId = normalizePositiveInt(variantId, "variantId");
        cleanProductId = normalizePositiveInt(productId, "productId");
        cleanQuantityOnHand = normalizeNonNegativeInt(quantityOnHand, "quantityOnHand");
    } catch (error) {
        return res.status(400).json({
            error: error.message
        });
    }

    let connection;

    try {
        connection = await dbPool.getConnection();
        await connection.beginTransaction();

        await connection.execute(
            `
            INSERT INTO inventory_items (
                variant_id,
                product_id,
                quantity_on_hand,
                quantity_reserved,
                quantity_sold
            )
            VALUES (?, ?, ?, 0, 0)
            ON DUPLICATE KEY UPDATE
                product_id = VALUES(product_id),
                quantity_on_hand = VALUES(quantity_on_hand)
            `,
            [
                cleanVariantId,
                cleanProductId,
                cleanQuantityOnHand
            ]
        );

        await insertMovement(connection, {
            variantId: cleanVariantId,
            movementType: "ADMIN_ADJUST",
            quantity: cleanQuantityOnHand,
            referenceType: "ADMIN",
            note: "Admin tạo/cập nhật tồn kho ban đầu"
        });

        await connection.commit();

        const inventories = await getInventoryByVariantIds([cleanVariantId]);

        return res.json({
            message: "Admin đã tạo/cập nhật tồn kho thành công!",
            inventory: inventories[0]
        });

    } catch (error) {
        if (connection) await connection.rollback();

        console.error("Lỗi tạo/cập nhật inventory item:", error);

        return res.status(500).json({
            error: "Không thể tạo/cập nhật tồn kho!"
        });

    } finally {
        if (connection) connection.release();
    }
});

// ========================================================================
// ROUTE ADMIN: ĐIỀU CHỈNH SỐ LƯỢNG TỒN KHO
// Body: { quantityOnHand, note }
// ========================================================================
app.put('/api/inventory/admin/variants/:variantId/stock', authMiddleware, adminMiddleware, async (req, res) => {
    const { variantId } = req.params;
    const { quantityOnHand, note } = req.body || {};

    let cleanVariantId;
    let cleanQuantityOnHand;

    try {
        cleanVariantId = normalizePositiveInt(variantId, "variantId");
        cleanQuantityOnHand = normalizeNonNegativeInt(quantityOnHand, "quantityOnHand");
    } catch (error) {
        return res.status(400).json({
            error: error.message
        });
    }

    let connection;

    try {
        connection = await dbPool.getConnection();
        await connection.beginTransaction();

        const [rows] = await connection.execute(
            `
            SELECT
                variant_id,
                quantity_reserved
            FROM inventory_items
            WHERE variant_id = ?
            FOR UPDATE
            `,
            [cleanVariantId]
        );

        if (rows.length === 0) {
            await connection.rollback();

            return res.status(404).json({
                error: "Không tìm thấy tồn kho của biến thể này!"
            });
        }

        const quantityReserved = Number(rows[0].quantity_reserved) || 0;

        if (cleanQuantityOnHand < quantityReserved) {
            await connection.rollback();

            return res.status(400).json({
                error: "quantityOnHand không được nhỏ hơn số lượng đang được giữ hàng!"
            });
        }

        await connection.execute(
            `
            UPDATE inventory_items
            SET quantity_on_hand = ?
            WHERE variant_id = ?
            `,
            [cleanQuantityOnHand, cleanVariantId]
        );

        await insertMovement(connection, {
            variantId: cleanVariantId,
            movementType: "ADMIN_ADJUST",
            quantity: cleanQuantityOnHand,
            referenceType: "ADMIN",
            note: note || "Admin điều chỉnh tồn kho"
        });

        await connection.commit();

        const inventories = await getInventoryByVariantIds([cleanVariantId]);

        return res.json({
            message: "Admin đã điều chỉnh tồn kho thành công!",
            inventory: inventories[0]
        });

    } catch (error) {
        if (connection) await connection.rollback();

        console.error("Lỗi điều chỉnh tồn kho:", error);

        return res.status(500).json({
            error: "Không thể điều chỉnh tồn kho!"
        });

    } finally {
        if (connection) connection.release();
    }
});

// ========================================================================
// ========================================================================

app.post('/api/inventory/internal/products/:productId/deactivate', internalMiddleware, async (req, res) => {
    const { productId } = req.params;

    let cleanProductId;

    try {
        cleanProductId = normalizePositiveInt(productId, "productId");
    } catch (error) {
        return res.status(400).json({
            error: error.message
        });
    }

    let connection;

    try {
        connection = await dbPool.getConnection();
        await connection.beginTransaction();

        const [reservedRows] = await connection.execute(
            `
            SELECT
                variant_id,
                quantity_reserved
            FROM inventory_items
            WHERE product_id = ?
              AND is_active = 1
              AND quantity_reserved > 0
            FOR UPDATE
            `,
            [cleanProductId]
        );

        if (reservedRows.length > 0) {
            await connection.rollback();

            return res.status(400).json({
                error: "Không thể xóa sản phẩm vì vẫn có biến thể đang được giữ hàng trong đơn hàng."
            });
        }

        await connection.execute(
            `
            UPDATE inventory_items
            SET is_active = 0
            WHERE product_id = ?
            `,
            [cleanProductId]
        );

        await connection.commit();

        return res.json({
            message: "Inventory đã deactivate toàn bộ tồn kho của product!"
        });

    } catch (error) {
        if (connection) await connection.rollback();

        console.error("Lỗi deactivate inventory theo product:", error);

        return res.status(500).json({
            error: "Không thể deactivate inventory của product!"
        });

    } finally {
        if (connection) connection.release();
    }
});

// ========================================================================
// INTERNAL: UPSERT INVENTORY CHO TOÀN BỘ VARIANT CỦA 1 PRODUCT
// ========================================================================
app.post('/api/inventory/internal/products/:productId/items/bulk-upsert', internalMiddleware, async (req, res) => {
    const { productId } = req.params;
    const { items } = req.body || {};

    let cleanProductId;

    try {
        cleanProductId = normalizePositiveInt(productId, "productId");
    } catch (error) {
        return res.status(400).json({
            error: error.message
        });
    }

    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({
            error: "items không được để trống!"
        });
    }

    const cleanItems = [];
    const duplicateMap = new Set();

    try {
        for (const item of items) {
            const variantId = normalizePositiveInt(item.variantId, "variantId");
            const quantityOnHand = normalizeNonNegativeInt(item.quantityOnHand, "quantityOnHand");

            if (duplicateMap.has(variantId)) {
                throw new Error(`variantId ${variantId} bị trùng trong request!`);
            }

            duplicateMap.add(variantId);

            cleanItems.push({
                variantId,
                quantityOnHand
            });
        }
    } catch (error) {
        return res.status(400).json({
            error: error.message
        });
    }

    let connection;

    try {
        connection = await dbPool.getConnection();
        await connection.beginTransaction();

        const activeVariantIds = cleanItems.map(item => item.variantId);
        const placeholders = activeVariantIds.map(() => "?").join(",");

        if (activeVariantIds.length > 0) {
            const [reservedRows] = await connection.execute(
                `
                SELECT
                    variant_id,
                    quantity_reserved
                FROM inventory_items
                WHERE product_id = ?
                  AND variant_id NOT IN (${placeholders})
                  AND quantity_reserved > 0
                FOR UPDATE
                `,
                [cleanProductId, ...activeVariantIds]
            );

            if (reservedRows.length > 0) {
                await connection.rollback();

                return res.status(400).json({
                    error: "Không thể bỏ biến thể đang có hàng được giữ trong đơn hàng."
                });
            }
        }

        await connection.execute(
            `
            UPDATE inventory_items
            SET is_active = 0
            WHERE product_id = ?
            `,
            [cleanProductId]
        );

        for (const item of cleanItems) {
            const [existingRows] = await connection.execute(
                `
                SELECT
                    variant_id,
                    quantity_reserved
                FROM inventory_items
                WHERE variant_id = ?
                FOR UPDATE
                `,
                [item.variantId]
            );

            if (existingRows.length > 0) {
                const reserved = Number(existingRows[0].quantity_reserved) || 0;

                if (item.quantityOnHand < reserved) {
                    await connection.rollback();

                    return res.status(400).json({
                        error: `Tồn kho của variant ${item.variantId} không được nhỏ hơn số lượng đang được giữ.`
                    });
                }
            }

            await connection.execute(
                `
                INSERT INTO inventory_items (
                    variant_id,
                    product_id,
                    quantity_on_hand,
                    quantity_reserved,
                    quantity_sold,
                    is_active
                )
                VALUES (?, ?, ?, 0, 0, 1)
                ON DUPLICATE KEY UPDATE
                    product_id = VALUES(product_id),
                    quantity_on_hand = VALUES(quantity_on_hand),
                    is_active = 1
                `,
                [
                    item.variantId,
                    cleanProductId,
                    item.quantityOnHand
                ]
            );

            await insertMovement(connection, {
                variantId: item.variantId,
                movementType: "ADMIN_ADJUST",
                quantity: item.quantityOnHand,
                referenceType: "PRODUCT_ADMIN",
                referenceId: String(cleanProductId),
                note: "Product Service cập nhật tồn kho theo biến thể"
            });
        }

        await connection.commit();

        return res.json({
            message: "Inventory đã cập nhật tồn kho cho product thành công!"
        });

    } catch (error) {
        if (connection) await connection.rollback();

        console.error("Lỗi bulk upsert inventory:", error);

        return res.status(500).json({
            error: "Không thể cập nhật tồn kho cho product!"
        });

    } finally {
        if (connection) connection.release();
    }
});

// ========================================================================
// INTERNAL: RESERVE HÀNG KHI CHECKOUT
// Body: { referenceType, referenceId, items: [{ variantId, quantity }] }
// ========================================================================
app.post('/api/inventory/internal/reserve', internalMiddleware, async (req, res) => {
    const { referenceType, referenceId, items } = req.body || {};

    let cleanItems;

    try {
        cleanItems = normalizeItems(items);
    } catch (error) {
        return res.status(400).json({
            error: error.message
        });
    }

    let connection;

    try {
        connection = await dbPool.getConnection();
        await connection.beginTransaction();

        for (const item of cleanItems) {
            const [rows] = await connection.execute(
                `
                SELECT
                    variant_id,
                    quantity_on_hand,
                    quantity_reserved
                FROM inventory_items
                WHERE variant_id = ?
                FOR UPDATE
                `,
                [item.variantId]
            );

            if (rows.length === 0) {
                await connection.rollback();

                return res.status(404).json({
                    error: `Không tìm thấy tồn kho cho variant_id ${item.variantId}!`
                });
            }

            const inventory = rows[0];
            const available =
                Number(inventory.quantity_on_hand) - Number(inventory.quantity_reserved);

            if (available < item.quantity) {
                await connection.rollback();

                return res.status(400).json({
                    error: `Variant ${item.variantId} không đủ hàng. Còn ${available}, cần ${item.quantity}.`
                });
            }

            await connection.execute(
                `
                UPDATE inventory_items
                SET quantity_reserved = quantity_reserved + ?
                WHERE variant_id = ?
                `,
                [item.quantity, item.variantId]
            );

            await insertMovement(connection, {
                variantId: item.variantId,
                movementType: "RESERVE",
                quantity: item.quantity,
                referenceType: referenceType || "ORDER",
                referenceId: referenceId || null,
                note: "Giữ hàng cho đơn hàng"
            });
        }

        await connection.commit();

        return res.json({
            message: "Inventory đã giữ hàng thành công!"
        });

    } catch (error) {
        if (connection) await connection.rollback();

        console.error("Lỗi reserve inventory:", error);

        return res.status(500).json({
            error: "Không thể giữ hàng trong kho!"
        });

    } finally {
        if (connection) connection.release();
    }
});

// ========================================================================
// INTERNAL: RELEASE HÀNG KHI PAYMENT FAILED / CANCEL TRƯỚC KHI TRỪ KHO
// Body: { referenceType, referenceId, items: [{ variantId, quantity }] }
// ========================================================================
app.post('/api/inventory/internal/release', internalMiddleware, async (req, res) => {
    const { referenceType, referenceId, items } = req.body || {};

    let cleanItems;

    try {
        cleanItems = normalizeItems(items);
    } catch (error) {
        return res.status(400).json({
            error: error.message
        });
    }

    let connection;

    try {
        connection = await dbPool.getConnection();
        await connection.beginTransaction();

        for (const item of cleanItems) {
            const [rows] = await connection.execute(
                `
                SELECT
                    variant_id,
                    quantity_reserved
                FROM inventory_items
                WHERE variant_id = ?
                FOR UPDATE
                `,
                [item.variantId]
            );

            if (rows.length === 0) {
                await connection.rollback();

                return res.status(404).json({
                    error: `Không tìm thấy tồn kho cho variant_id ${item.variantId}!`
                });
            }

            const reserved = Number(rows[0].quantity_reserved) || 0;

            if (reserved < item.quantity) {
                await connection.rollback();

                return res.status(400).json({
                    error: `Variant ${item.variantId} không đủ reserved để release. Reserved ${reserved}, cần release ${item.quantity}.`
                });
            }

            await connection.execute(
                `
                UPDATE inventory_items
                SET quantity_reserved = quantity_reserved - ?
                WHERE variant_id = ?
                `,
                [item.quantity, item.variantId]
            );

            await insertMovement(connection, {
                variantId: item.variantId,
                movementType: "RELEASE",
                quantity: item.quantity,
                referenceType: referenceType || "ORDER",
                referenceId: referenceId || null,
                note: "Hoàn giữ hàng"
            });
        }

        await connection.commit();

        return res.json({
            message: "Inventory đã hoàn giữ hàng thành công!"
        });

    } catch (error) {
        if (connection) await connection.rollback();

        console.error("Lỗi release inventory:", error);

        return res.status(500).json({
            error: "Không thể hoàn giữ hàng!"
        });

    } finally {
        if (connection) connection.release();
    }
});

// ========================================================================
// INTERNAL: COMMIT HÀNG KHI ĐƠN ĐƯỢC XÁC NHẬN / CHUẨN BỊ GIAO
// Body: { referenceType, referenceId, items: [{ variantId, quantity }] }
// ========================================================================
app.post('/api/inventory/internal/commit', internalMiddleware, async (req, res) => {
    const { referenceType, referenceId, items } = req.body || {};

    let cleanItems;

    try {
        cleanItems = normalizeItems(items);
    } catch (error) {
        return res.status(400).json({
            error: error.message
        });
    }

    let connection;

    try {
        connection = await dbPool.getConnection();
        await connection.beginTransaction();

        for (const item of cleanItems) {
            const [rows] = await connection.execute(
                `
                SELECT
                    variant_id,
                    quantity_on_hand,
                    quantity_reserved
                FROM inventory_items
                WHERE variant_id = ?
                FOR UPDATE
                `,
                [item.variantId]
            );

            if (rows.length === 0) {
                await connection.rollback();

                return res.status(404).json({
                    error: `Không tìm thấy tồn kho cho variant_id ${item.variantId}!`
                });
            }

            const inventory = rows[0];
            const onHand = Number(inventory.quantity_on_hand) || 0;
            const reserved = Number(inventory.quantity_reserved) || 0;

            if (reserved < item.quantity) {
                await connection.rollback();

                return res.status(400).json({
                    error: `Variant ${item.variantId} không đủ reserved để commit. Reserved ${reserved}, cần commit ${item.quantity}.`
                });
            }

            if (onHand < item.quantity) {
                await connection.rollback();

                return res.status(400).json({
                    error: `Variant ${item.variantId} không đủ on hand để commit. On hand ${onHand}, cần commit ${item.quantity}.`
                });
            }

            await connection.execute(
                `
                UPDATE inventory_items
                SET
                    quantity_reserved = quantity_reserved - ?,
                    quantity_on_hand = quantity_on_hand - ?
                WHERE variant_id = ?
                `,
                [item.quantity, item.quantity, item.variantId]
            );

            await insertMovement(connection, {
                variantId: item.variantId,
                movementType: "COMMIT",
                quantity: item.quantity,
                referenceType: referenceType || "ORDER",
                referenceId: referenceId || null,
                note: "Trừ kho cho đơn hàng"
            });
        }

        await connection.commit();

        return res.json({
            message: "Inventory đã trừ kho thành công!"
        });

    } catch (error) {
        if (connection) await connection.rollback();

        console.error("Lỗi commit inventory:", error);

        return res.status(500).json({
            error: "Không thể trừ kho!"
        });

    } finally {
        if (connection) connection.release();
    }
});

// ========================================================================
// INTERNAL: CỘNG SOLD KHI KHÁCH XÁC NHẬN ĐÃ NHẬN HÀNG
// Body: { referenceType, referenceId, items: [{ variantId, quantity }] }
// ========================================================================
app.post('/api/inventory/internal/mark-sold', internalMiddleware, async (req, res) => {
    const { referenceType, referenceId, items } = req.body || {};

    let cleanItems;

    try {
        cleanItems = normalizeItems(items);
    } catch (error) {
        return res.status(400).json({
            error: error.message
        });
    }

    let connection;

    try {
        connection = await dbPool.getConnection();
        await connection.beginTransaction();

        for (const item of cleanItems) {
            const [rows] = await connection.execute(
                `
                SELECT variant_id
                FROM inventory_items
                WHERE variant_id = ?
                FOR UPDATE
                `,
                [item.variantId]
            );

            if (rows.length === 0) {
                await connection.rollback();

                return res.status(404).json({
                    error: `Không tìm thấy tồn kho cho variant_id ${item.variantId}!`
                });
            }

            await connection.execute(
                `
                UPDATE inventory_items
                SET quantity_sold = quantity_sold + ?
                WHERE variant_id = ?
                `,
                [item.quantity, item.variantId]
            );

            await insertMovement(connection, {
                variantId: item.variantId,
                movementType: "SOLD",
                quantity: item.quantity,
                referenceType: referenceType || "ORDER",
                referenceId: referenceId || null,
                note: "Cộng số lượng đã bán"
            });
        }

        await connection.commit();

        return res.json({
            message: "Inventory đã cập nhật số lượng đã bán thành công!"
        });

    } catch (error) {
        if (connection) await connection.rollback();

        console.error("Lỗi mark sold inventory:", error);

        return res.status(500).json({
            error: "Không thể cập nhật số lượng đã bán!"
        });

    } finally {
        if (connection) connection.release();
    }
});


// Khởi chạy Inventory Service
const PORT = process.env.PORT || 3002;

app.listen(PORT, () => {
    console.log(`Inventory Service running on port ${PORT}`);
});
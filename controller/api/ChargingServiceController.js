import path from 'path';
import moment from "moment";
import dotenv from 'dotenv';
import 'moment-duration-format';
import { fileURLToPath } from 'url';
import emailQueue from "../../emailQueue.js";
import validateFields from "../../validation.js";
import { insertRecord, queryDB, getPaginatedData, updateRecord } from '../../dbUtils.js';
import db, { startTransaction, commitTransaction, rollbackTransaction } from "../../config/db.js";
import { createNotification, mergeParam, pushNotification, formatDateTimeInQuery, asyncHandler, formatDateInQuery, numberToWords, formatNumber, generatePdf } from "../../utils.js";
dotenv.config();

import Stripe from "stripe";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const getChargingServiceSlotList = asyncHandler(async (req, resp) => {
    const { slot_date } = mergeParam(req);
    if(!slot_date) return resp.json({status:0, code:422, message: 'slot date is required'});
    
    const fSlotDate = moment(slot_date, 'YYYY-MM-DD').format('YYYY-MM-DD');
    let query = `SELECT slot_id, ${formatDateInQuery([('slot_date')])}, start_time, end_time, booking_limit`;
    
    if(fSlotDate >=  moment().format('YYYY-MM-DD')){
        query += `,(SELECT COUNT(id) FROM charging_service AS cs WHERE cs.slot=pick_drop_slot.slot_id AND DATE(cs.slot_date_time)='${slot_date}' AND order_status NOT IN ("PU", "C") ) AS slot_booking_count`;
    }

    query += ` FROM pick_drop_slot WHERE status = ? AND slot_date = ? ORDER BY start_time ASC`;

    const [slot] = await db.execute(query, [1, fSlotDate]);

    return resp.json({ message: "Slot List fetch successfully!",  data: slot, status: 1, code: 200, alert2: "The slots for your selected date are fully booked. Please choose another date to book our valet service for your EV." });
});

export const requestService = asyncHandler(async (req, resp) => {
    const { rider_id, name, country_code, contact_no, slot_id, pickup_address, pickup_latitude, pickup_longitude,vehicle_id, parking_number, parking_floor, 
        slot_date_time, price = '', order_status = 'PNR'
    } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {
        rider_id         : ["required"],
        name             : ["required"],
        country_code     : ["required"],
        contact_no       : ["required"],
        slot_id          : ["required"],
        pickup_address   : ["required"],
        pickup_latitude  : ["required"],
        pickup_longitude : ["required"],
        vehicle_id       : ["required"],
        parking_number   : ["required"],
        parking_floor    : ["required"],
        slot_date_time   : ["required"],
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
    
    const conn = await startTransaction();
    try{
        const fSlotDateTime = moment(slot_date_time, 'YYYY-MM-DD HH:mm:ss').format('YYYY-MM-DD HH:mm:ss');
        const currDateTime = moment().utcOffset(4).format('YYYY-MM-DD HH:mm:ss');
        if (fSlotDateTime < currDateTime) return resp.json({status: 0, code: 422, message: ["Invalid slot, Please select another slot"]});
        // fcm_token, rider_name, rider_email,
        const rider = await queryDB(`
            SELECT 
                (SELECT MAX(id) FROM charging_service) AS last_index,
                (SELECT booking_limit FROM pick_drop_slot AS pds WHERE pds.slot_id=?) AS booking_limit,
                (select count(id) from charging_service as cs where cs.slot_date_time = ? and order_status NOT IN ("WC", "C") ) as slot_booking_count 
            FROM 
                riders 
            WHERE 
                rider_id=? 
            LIMIT 1
        `, [slot_id, slot_date_time, rider_id]);

        if(rider.slot_booking_count >= rider.booking_limit) return resp.json({status: 1, code: 405, message: ["Booking Slot Full!, please select another slot"]});
        
        const nextId       = (!rider.last_index) ? 0 : rider.last_index + 1;
        const requestId    = 'CS' + String(nextId).padStart(4, '0');
        const slotDateTime = moment(slot_date_time).format('YYYY-MM-DD HH:mm:ss');
        const fslotDateTime = moment(slot_date_time).format('D MMM, YYYY, h:mm A');

        const insert       = await insertRecord('charging_service', [
            'request_id', 'rider_id', 'name', 'country_code', 'contact_no', 'vehicle_id', 'slot', 'slot_date_time', 'pickup_address', 'parking_number', 'parking_floor', 
            'price', 'order_status', 'pickup_latitude', 'pickup_longitude', 
        ],[
            requestId, rider_id, name, country_code, contact_no, vehicle_id, slot_id, slotDateTime, pickup_address, parking_number, parking_floor, price, 
            order_status, pickup_latitude, pickup_longitude
        ], conn);

        if(insert.affectedRows === 0) return resp.json({status:0, code:200, message: ["Oops! Something went wrong. Please try again."]}); 

        // if(coupan_code){
        //     await insertRecord('coupon_usage', ['coupan_code', 'user_id', 'booking_id'], [coupan_code, rider_id, requestId], conn);
        // }
        // await insertRecord('charging_service_history', ['service_id', 'rider_id', 'order_status'], [requestId, rider_id, 'CNF'], conn);
    
        // const href = 'charging_service/' + requestId;
        // const heading = 'EV Valet Charging Service Booking!';
        // const desc = `Booking Confirmed! ID: ${requestId}.`;
        // createNotification(heading, desc, 'Charging Service', 'Rider', 'Admin','', rider_id, href);
        // pushNotification(rider.fcm_token, heading, desc, 'RDRFCM', href);
    
        // const formattedDateTime = moment().format('DD MMM YYYY hh:mm A');

        // const htmlUser = `<html>
        //     <body>
        //         <h4>Dear ${name},</h4>
        //         <p>Thank you for choosing our EV Pickup and Drop Off service. We are pleased to confirm that your booking has been successfully received.</p>
        //         Booking Details:
        //         <br>
        //         <ul>
        //         <li>Booking ID: ${requestId}</li>
        //         <li>Date and Time of Service : ${fslotDateTime}</li>
        //         <li>Address : ${pickup_address}</li>
        //         </ul>
        //         <p>We look forward to serving you and providing a seamless EV experience.</p>   
        //         <p>Best Regards,<br/> PlusX Electric Team </p>
        //     </body>
        // </html>`;
        // emailQueue.addEmail(rider.rider_email, 'PlusX Electric App: Booking Confirmation for Your EV Pickup and Drop Off Service', htmlUser);
        
        // const htmlAdmin = `<html>
        //     <body>
        //         <h4>Dear Admin,</h4>
        //         <p>We have received a new booking for our Valet Charging service via the PlusX app. Below are the details:</p> 
        //         Customer Name  : ${name}<br>
        //         Pickup & Drop Address : ${pickup_address}<br>
        //         Booking Date & Time : ${formattedDateTime}<br>                
        //         <p> Best regards,<br/> PlusX Electric Team </p>
        //     </body>
        // </html>`;
        // emailQueue.addEmail(process.env.MAIL_CS_ADMIN, `Valet Charging Service Booking Received - ${requestId}`, htmlAdmin);
        // let responseMsg = 'Booking request submitted! Our team will be in touch with you shortly.';
    
        await commitTransaction(conn);
        return resp.json({
            message       : ["Booking Request Received!."], // [responseMsg],
            status        : 1,
            service_id    : requestId,
            code          : 200,
        });
    } catch(err) {
        await rollbackTransaction(conn);
        console.error("Transaction failed:", err);
        return resp.status(500).json({
            status  : 0, 
            code    : 500, 
            message : ["Oops! There is something went wrong! Please Try Again"]
        });
    } finally {
        if (conn) conn.release();
    }
});

export const listServices = asyncHandler(async (req, resp) => {
    const {rider_id, page_no, history } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {rider_id: ["required"], page_no: ["required"]});
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const limit = 10;
    const start = (page_no[0] * limit) - limit;
    const statusCondition = (history && history == 1) ? `order_status IN (?, ?)` : `order_status NOT IN (?, ?)`;
    const statusParams = ['WC', 'C'];

    const totalQuery = `SELECT COUNT(*) AS total FROM charging_service WHERE rider_id = ? AND ${statusCondition}`;
    const [totalRows] = await db.execute(totalQuery, [rider_id, ...statusParams]);
    const total = totalRows[0].total;
    const totalPage = Math.max(Math.ceil(total / limit), 1);
    
    const formatCols = ['slot_date_time', 'created_at'];
    const servicesQuery = `SELECT request_id, name, country_code, contact_no, slot, ROUND(charging_service.price / 100, 2) AS price, pickup_address, order_status, ${formatDateTimeInQuery(formatCols)} 
    FROM charging_service WHERE rider_id = ? AND ${statusCondition} ORDER BY id DESC LIMIT ${parseInt(start)}, ${parseInt(limit)}
    `;
    
    const [serviceList] = await db.execute(servicesQuery, [rider_id, ...statusParams]);

    return resp.json({
        message: ["Charging Service List fetch successfully!"],
        data: serviceList,
        total_page: totalPage,
        total,
        status: 1,
        code: 200,
    });
});

export const getServiceOrderDetail = asyncHandler(async (req, resp) => {
    const {rider_id, service_id } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {rider_id: ["required"], service_id: ["required"]});
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const formatCols = ['created_at', 'updated_at']; // 'slot_date_time', 
    
    const order = await queryDB(`
        SELECT 
            charging_service.*, 
            ROUND(charging_service.price / 100, 2) AS price, 
            (select concat(vehicle_make, "-", vehicle_model) from riders_vehicles as rv where rv.vehicle_id = charging_service.vehicle_id) as vehicle_data, 
            ${formatDateTimeInQuery(formatCols)} 
        FROM charging_service 
        WHERE request_id = ? 
        LIMIT 1
    `, [service_id]);
    // formatCols.shift();
    const [history] = await db.execute(`SELECT *, ${formatDateTimeInQuery(formatCols)} FROM charging_service_history WHERE service_id = ?`, [service_id]);

    if(order){
        order.invoice_url = '';
        order.slot = 'Schedule';
        if (order.order_status == 'WC') {
            const invoiceId = order.request_id.replace('CS', 'INVCS');
            order.invoice_url = `${req.protocol}://${req.get('host')}/public/pick-drop-invoice/${invoiceId}-invoice.pdf`;
        }
    }
    order.slot_date_time = moment(order.slot_date_time ).format('YYYY-MM-DD HH:mm:ss');
    return resp.json({
        message: ["Service Order Details fetched successfully!"],
        order_data: order,
        order_history: history,
        status: 1,
        code: 200,
    });
});

/* Invoice */
export const getInvoiceList = asyncHandler(async (req, resp) => {
    const {rider_id, page_no, orderStatus } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {rider_id: ["required"], page_no: ["required"]});
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    let whereField = ['rider_id'];
    let whereValue = [rider_id];

    if(orderStatus){
        whereField.push('payment_status');
        whereValue.push(orderStatus);
    }

    const result = await getPaginatedData({
        tableName: 'charging_service_invoice',
        columns: `invoice_id, amount, payment_status, invoice_date, currency, 
            (select concat(name, ",", country_code, "-", contact_no) from charging_service as cs where cs.request_id = charging_service_invoice.request_id limit 1)
            AS riderDetails`,
        sortColumn: 'id',
        sortOrder: 'DESC',
        page_no,
        limit: 10,
        whereField,
        whereValue
    });

    return resp.json({
        status: 1,
        code: 200,
        message: ["Pick & Drop Invoice List fetch successfully!"],
        data: result.data,
        total_page: result.totalPage,
        total: result.total,
        base_url: `${req.protocol}://${req.get('host')}/uploads/pick-drop-invoice/`,
    });
});
export const getInvoiceDetail = asyncHandler(async (req, resp) => {
    const {rider_id, invoice_id } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {rider_id: ["required"], invoice_id: ["required"]});
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const invoice = await queryDB(`SELECT 
        invoice_id, amount as price, payment_status, invoice_date, currency, payment_type, cs.name, cs.country_code, cs.contact_no, cs.pickup_address, cs.vehicle_id, 
        cs.request_id, cs.slot_date_time, (select concat(vehicle_make, "-", vehicle_model) from riders_vehicles as rv where rv.vehicle_id = cs.vehicle_id) as vehicle_data
        FROM 
            charging_service_invoice AS csi
        LEFT JOIN
            charging_service AS cs ON cs.request_id = csi.request_id
        WHERE 
            csi.invoice_id = ?
    `, [invoice_id]);

    invoice.invoice_url = `${req.protocol}://${req.get('host')}/public/pick-drop-invoice/${invoice_id}-invoice.pdf`;

    return resp.json({
        message: ["Pick & Drop Invoice Details fetch successfully!"],
        data: invoice,
        status: 1,
        code: 200,
    });
});

/* RSA - Booking Action */
export const getRsaBookingStage = asyncHandler(async (req, resp) => {
    const {rsa_id, booking_id } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {rsa_id: ["required"], booking_id: ["required"]});
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const booking = await queryDB(`SELECT order_status, created_at, updated_at FROM charging_service WHERE request_id=?`, [booking_id]);
    if(!booking) return resp.json({status:0, code:200, message: "Sorry no data found with given order id: " + booking_id}); 

    const orderStatus = ['CNF','A', 'VP', 'RS','CC','DO','WC', 'C']; //order_status 
    const placeholders = orderStatus.map(() => '?').join(', ');

    const [bookingTracking] = await db.execute(`SELECT order_status, remarks, image, cancel_reason, cancel_by, longitude, latitude FROM charging_service_history 
        WHERE service_id = ? AND rsa_id = ? AND order_status IN (${placeholders})
    `, [booking_id, rsa_id, ...orderStatus]);

    const seconds = Math.floor((booking.updated_at - booking.created_at) / 1000);
    const humanReadableDuration = moment.duration(seconds, 'seconds').format('h [hours], m [minutes]');
    
    return resp.json({
        status          : 1,
        code            : 200,
        message         : ["Booking stage fetch successfully."],
        booking_status  : booking.order_status,
        execution_time  : humanReadableDuration,
        booking_history : bookingTracking,
        image_path      : `${req.protocol}://${req.get('host')}/uploads/pick-drop-images/`
    });
});

export const handleBookingAction = asyncHandler(async (req, resp) => {
    const {rsa_id, booking_id, reason, latitude, longitude, booking_status } = req.body;
    let validationRules = {
        rsa_id         : ["required"], 
        booking_id     : ["required"], 
        latitude       : ["required"], 
        longitude      : ["required"], 
        booking_status : ["required"],
    };
    if (booking_status == "C") validationRules = { ...validationRules, reason : ["required"] };
    const { isValid, errors } = validateFields(req.body, validationRules);
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
    
    switch (booking_status) {
        case 'A': return await acceptBooking(req, resp);
        case 'ER': return await driverEnroute(req, resp);
        case 'VP': return await vehiclePickUp(req, resp);
        case 'RS': return await reachedLocation(req, resp);
        case 'CC': return await chargingComplete(req, resp);
        case 'DO': return await vehicleDrop(req, resp);
        case 'WC': return await workComplete(req, resp);
        default: return resp.json({status: 0, code: 200, message: ['Invalid booking status.']});
    };
});

export const handleRejectBooking = asyncHandler(async (req, resp) => {
    const {rsa_id, booking_id, reason, latitude='', longitude='' } = req.body;
    const { isValid, errors } = validateFields(req.body, {rsa_id: ["required"], booking_id: ["required"], reason: ["required"]});
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const checkOrder = await queryDB(`
        SELECT rider_id, 
            (SELECT fcm_token FROM riders WHERE rider_id = charging_service_assign.rider_id) AS fcm_token
        FROM 
            charging_service_assign
        WHERE 
            order_id = ? AND rsa_id = ? AND status = 0
        LIMIT 1
    `,[booking_id, rsa_id]);

    if (!checkOrder) {
        return resp.json({ message: [`Sorry no booking found with this booking id ${booking_id}`], status: 0, code: 404 });
    }

    const insert = await db.execute(
        'INSERT INTO charging_service_history (service_id, rider_id, order_status, rsa_id, latitude, longitude) VALUES (?, ?, "C", ?, ?, ?)',
        [booking_id, checkOrder.rider_id, rsa_id, latitude, longitude]
    );

    if(insert.affectedRows == 0) return resp.json({ message: ['Oops! Something went wrong! Please Try Again'], status: 0, code: 200 });

    await insertRecord('charging_service_rejected', ['booking_id', 'rsa_id', 'rider_id', 'reason'],[booking_id, rsa_id, checkOrder.rider_id, reason]);
    await db.execute(`DELETE FROM charging_service_assign WHERE order_id=? AND rsa_id=?`, [booking_id, rsa_id]);

    const href = `charging_service/${booking_id}`;
    const title = 'Booking Rejected';
    const message = `Driver has rejected the valet service booking with booking id: ${booking_id}`;
    await createNotification(title, message, 'Charging Service', 'Rider', 'RSA', rsa_id, checkOrder.rider_id, href);

    const html = `<html>
        <body>
            <h4>Dear Admin,</h4>
            <p>Driver has rejected the valet service booking. please assign one Driver on this booking</p> <br />
            <p>Booking ID: ${booking_id}</p>
            <p> Regards,<br/> PlusX Electric App </p>
        </body>
    </html>`;
    emailQueue.addEmail(process.env.MAIL_CS_ADMIN, `Valet Charging Service Booking rejected - ${booking_id}`, html);

    return resp.json({ message: ['Booking has been rejected successfully!'], status: 1, code: 200 });
});

/* CS booking action helper */
const acceptBooking = async (req, resp) => {
    const { booking_id, rsa_id, latitude, longitude, booking_status } = req.body;

    const checkOrder = await queryDB(`
        SELECT rider_id, 
            (SELECT fcm_token FROM riders WHERE rider_id = charging_service_assign.rider_id) AS fcm_token,
            (SELECT COUNT(id) FROM charging_service_assign WHERE rsa_id = ? AND status = 1) AS count
        FROM 
            charging_service_assign
        WHERE 
            order_id = ? AND rsa_id = ? AND status = 0
        LIMIT 1
    `,[rsa_id, booking_id, rsa_id]);

    if (!checkOrder) {
        return resp.json({ message: [`Sorry no booking found with this booking id ${booking_id}`], status: 0, code: 404 });
    }
    // if (checkOrder.count > 0) {
    //     return resp.json({ message: ['You have already one booking, please complete that first!'], status: 0, code: 404 });
    // }
    const ordHistoryCount = await queryDB(
        `SELECT COUNT(*) as count FROM charging_service_history WHERE rsa_id = ? AND order_status = "A" AND service_id = ?`,[rsa_id, booking_id]
    );
    if (ordHistoryCount.count === 0) {
        await updateRecord('charging_service', {order_status: 'A', rsa_id}, ['request_id'], [booking_id]);

        const href = `charging_service/${booking_id}`;
        const title = 'EV Valet Charging Service Booking Accepted';
        const message = `Booking Accepted! ID: ${booking_id}.`;
        await createNotification(title, message, 'Charging Service', 'Rider', 'RSA', rsa_id, checkOrder.rider_id, href);
        await pushNotification(checkOrder.fcm_token, title, message, 'RDRFCM', href);

        const insert = await db.execute(
            `INSERT INTO charging_service_history (service_id, rider_id, order_status, rsa_id, latitude, longitude) VALUES (?, ?, "A", ?, ?, ?)`,
            [booking_id, checkOrder.rider_id, rsa_id, latitude, longitude]
        );

        if(insert.affectedRows == 0) return resp.json({ message: ['Oops! Something went wrong! Please Try Again'], status: 0, code: 200 });

        await db.execute('UPDATE rsa SET running_order = running_order + 1 WHERE rsa_id = ?', [rsa_id]);
        await db.execute('UPDATE charging_service_assign SET status = 1 WHERE order_id = ? AND rsa_id = ?', [booking_id, rsa_id]);

        return resp.json({ message: ['Charging Service Booking accepted successfully!'], status: 1, code: 200 });
    } else {
        return resp.json({ message: ['Sorry this is a duplicate entry!'], status: 0, code: 200 });
    }
};
const driverEnroute = async (req, resp) => {
    const { booking_id, rsa_id, latitude, longitude } = req.body;
    
    const checkOrder = await queryDB(`
        SELECT rider_id, 
            (SELECT fcm_token FROM riders WHERE rider_id = charging_service_assign.rider_id) AS fcm_token 
        FROM 
            charging_service_assign
        WHERE 
            order_id = ? AND rsa_id = ? AND status = 1
        LIMIT 1
    `,[booking_id, rsa_id]);
  
    if (!checkOrder) {
        return resp.json({ message: [`Sorry no booking found with this booking id ${booking_id}`], status: 0, code: 404 });
    }
    const ordHistoryCount = await queryDB(
        `SELECT COUNT(*) as count FROM charging_service_history WHERE rsa_id = ? AND order_status = "ER" AND service_id = ?`,[rsa_id, booking_id]
    );
    if (ordHistoryCount.count === 0) {
        await updateRecord('charging_service', {order_status: 'ER'}, ['request_id'], [booking_id]);

        const href    = `charging_service/${booking_id}`;
        const title   = 'PlusX Electric team is on the way!';
        const message = `Please have your EV ready.`;
        await createNotification(title, message, 'Charging Service', 'Rider', 'RSA', rsa_id, checkOrder.rider_id, href);
        await pushNotification(checkOrder.fcm_token, title, message, 'RDRFCM', href);

        const insert = await db.execute(
            `INSERT INTO charging_service_history (service_id, rider_id, order_status, rsa_id, latitude, longitude) VALUES (?, ?, "ER", ?, ?, ?)`,
            [booking_id, checkOrder.rider_id, rsa_id, latitude, longitude]
        );
        if(insert.affectedRows == 0) return resp.json({ message: ['Oops! Something went wrong! Please Try Again'], status: 0, code: 200 });

        return resp.json({ message: ['Booking Status changed successfully!'], status: 1, code: 200 });
    } else {
        return resp.json({ message: ['Sorry this is a duplicate entry!'], status: 0, code: 200 });
    }
};
const vehiclePickUp = async (req, resp) => {
    const { booking_id, rsa_id, latitude, longitude } = req.body;

    const checkOrder = await queryDB(`
        SELECT rider_id, 
            (SELECT fcm_token FROM riders WHERE rider_id = charging_service_assign.rider_id) AS fcm_token
        FROM 
            charging_service_assign
        WHERE 
            order_id = ? AND rsa_id = ? AND status = 1
        LIMIT 1
    `,[ booking_id, rsa_id]);

    if (!checkOrder) {
        return resp.json({ message: [`Sorry no booking found with this booking id ${booking_id}`], status: 0, code: 404 });
    }

    const ordHistoryCount = await queryDB(
        'SELECT COUNT(*) as count FROM charging_service_history WHERE rsa_id = ? AND order_status = "VP" AND service_id = ?',[rsa_id, booking_id]
    );

    if (ordHistoryCount.count === 0) {
        const insert = await db.execute(
            'INSERT INTO charging_service_history (service_id, rider_id, order_status, rsa_id, latitude, longitude, image) VALUES (?, ?, "VP", ?, ?, ?, ?)',
            [booking_id, checkOrder.rider_id, rsa_id, latitude, longitude, '']
        );

        if(insert.affectedRows == 0) return resp.json({ message: ['Oops! Something went wrong! Please Try Again'], status: 0, code: 200 });

        await updateRecord('charging_service', {order_status: 'VP', rsa_id}, ['request_id'], [booking_id]);

        const href = `charging_service/${booking_id}`;
        const title = 'EV Pick-Up Confirmed';
        const message = `PlusX Electric team has picked up your EV.`;
        await createNotification(title, message, 'Charging Service', 'Rider', 'RSA', rsa_id, checkOrder.rider_id, href);
        await pushNotification(checkOrder.fcm_token, title, message, 'RDRFCM', href);

        return resp.json({ message: ['Vehicle picked-up successfully!'], status: 1, code: 200 });
    } else {
        return resp.json({ message: ['Sorry this is a duplicate entry!'], status: 0, code: 200 });
    }
};
const reachedLocation = async (req, resp) => {
    const { booking_id, rsa_id, latitude, longitude } = req.body;

    const checkOrder = await queryDB(`
        SELECT rider_id, 
            (SELECT fcm_token FROM riders WHERE rider_id = charging_service_assign.rider_id) AS fcm_token
        FROM 
            charging_service_assign
        WHERE 
            order_id = ? AND rsa_id = ? AND status = 1
        LIMIT 1
    `,[booking_id, rsa_id]);

    if (!checkOrder) {
        return resp.json({ message: [`Sorry no booking found with this booking id ${booking_id}`], status: 0, code: 404 });
    }

    const ordHistoryCount = await queryDB(
        'SELECT COUNT(*) as count FROM charging_service_history WHERE rsa_id = ? AND order_status = "RS" AND service_id = ?',[rsa_id, booking_id]
    );

    if (ordHistoryCount.count === 0) {
        const insert = await db.execute(
            'INSERT INTO charging_service_history (service_id, rider_id, order_status, rsa_id, latitude, longitude) VALUES (?, ?, "RS", ?, ?, ?)',
            [booking_id, checkOrder.rider_id, rsa_id, latitude, longitude]
        );

        if(insert.affectedRows == 0) return resp.json({ message: ['Oops! Something went wrong! Please Try Again'], status: 0, code: 200 });

        await updateRecord('charging_service', {order_status: 'RS', rsa_id}, ['request_id'], [booking_id]);

        const href = `charging_service/${booking_id}`;
        const title = 'EV Reached Charging Spot';
        const message = `Your EV has reached the charging station.`;
        await createNotification(title, message, 'Charging Service', 'Rider', 'RSA', rsa_id, checkOrder.rider_id, href);
        await pushNotification(checkOrder.fcm_token, title, message, 'RDRFCM', href);

        return resp.json({ message: ['Vehicle reached at charging spot successfully!'], status: 1, code: 200 });
    } else {
        return resp.json({ message: ['Sorry this is a duplicate entry!'], status: 0, code: 200 });
    }
};
const chargingComplete = async (req, resp) => {
    const { booking_id, rsa_id, latitude, longitude } = req.body;

    const checkOrder = await queryDB(`
        SELECT rider_id, 
            (SELECT fcm_token FROM riders WHERE rider_id = charging_service_assign.rider_id) AS fcm_token
        FROM 
            charging_service_assign
        WHERE 
            order_id = ? AND rsa_id = ? AND status = 1
        LIMIT 1
    `,[booking_id, rsa_id]);

    if (!checkOrder) {
        return resp.json({ message: [`Sorry no booking found with this booking id ${booking_id}`], status: 0, code: 404 });
    }

    const ordHistoryCount = await queryDB(
        'SELECT COUNT(*) as count FROM charging_service_history WHERE rsa_id = ? AND order_status = "CC" AND service_id = ?',[rsa_id, booking_id]
    );

    if (ordHistoryCount.count === 0) {
        const insert = await db.execute(
            'INSERT INTO charging_service_history (service_id, rider_id, order_status, rsa_id, latitude, longitude) VALUES (?, ?, "CC", ?, ?, ?)',
            [booking_id, checkOrder.rider_id, rsa_id, latitude, longitude]
        );

        if(insert.affectedRows == 0) return resp.json({ message: ['Oops! Something went wrong! Please Try Again'], status: 0, code: 200 });

        await updateRecord('charging_service', {order_status: 'CC', rsa_id}, ['request_id'], [booking_id]);

        const href = `charging_service/${booking_id}`;
        const title = 'Charging Completed!';
        const message = `Your EV charging is completed!`;
        await createNotification(title, message, 'Charging Service', 'Rider', 'RSA', rsa_id, checkOrder.rider_id, href);
        await pushNotification(checkOrder.fcm_token, title, message, 'RDRFCM', href);

        return resp.json({ message: ['Vehicle charging completed! successfully!'], status: 1, code: 200 });
    } else {
        return resp.json({ message: ['Sorry this is a duplicate entry!'], status: 0, code: 200 });
    }
};
const vehicleDrop = async (req, resp) => {
    const { booking_id, rsa_id, latitude, longitude } = req.body;

    const checkOrder = await queryDB(`
        SELECT rider_id, 
            (SELECT fcm_token FROM riders WHERE rider_id = charging_service_assign.rider_id) AS fcm_token
        FROM 
            charging_service_assign
        WHERE 
            order_id = ? AND rsa_id = ? AND status = 1
        LIMIT 1
    `,[booking_id, rsa_id]);

    if (!checkOrder) {
        return resp.json({ message: [`Sorry no booking found with this booking id ${booking_id}`], status: 0, code: 404 });
    }
    const ordHistoryCount = await queryDB(
        'SELECT COUNT(*) as count FROM charging_service_history WHERE rsa_id = ? AND order_status = "DO" AND service_id = ?',[rsa_id, booking_id]
    );
    if (ordHistoryCount.count === 0) {
        const insert = await db.execute(
            'INSERT INTO charging_service_history (service_id, rider_id, order_status, rsa_id, latitude, longitude, image) VALUES (?, ?, "DO", ?, ?, ?, ?)',
            [booking_id, checkOrder.rider_id, rsa_id, latitude, longitude, '']
        );

        if(insert.affectedRows == 0) return resp.json({ message: ['Oops! Something went wrong! Please Try Again'], status: 0, code: 200 });

        await updateRecord('charging_service', {order_status: 'DO', rsa_id}, ['request_id'], [booking_id]);

        const href    = `charging_service/${booking_id}`;
        const title   = 'EV Drop Off!';
        const message = 'PlusX Electric Team has dropped off your EV and handed over the key!';
        await createNotification(title, message, 'Charging Service', 'Rider', 'RSA', rsa_id, checkOrder.rider_id, href);
        await pushNotification(checkOrder.fcm_token, title, message, 'RDRFCM', href);
        // console.log('Before Invoice')
        await valetChargerInvoice(checkOrder.rider_id, booking_id); 
        return resp.json({ message: ['Vehicle drop-off successfully!'], status: 1, code: 200 });
    } else {
        return resp.json({ message: ['Sorry this is a duplicate entry!'], status: 0, code: 200 });
    }
};
const workComplete = async (req, resp) => {
    const { booking_id, rsa_id, latitude, longitude } = req.body;
    if (!req.files || !req.files['image']) return resp.status(405).json({ message: "Vehicle Image is required", status: 0, code: 405, error: true });
    const imgName = req.files.image[0].filename; 
    const invoiceId = booking_id.replace('CS', 'INVCS');
    
    const checkOrder = await queryDB(`
        SELECT rider_id, 
            (SELECT fcm_token FROM riders WHERE rider_id = charging_service_assign.rider_id) AS fcm_token,
            (select slot from charging_service as cs where cs.request_id = charging_service_assign.order_id ) as slot_id
        FROM 
            charging_service_assign
        WHERE 
            order_id = ? AND rsa_id = ? AND status = 1
        LIMIT 1
    `,[booking_id, rsa_id]);
    if (!checkOrder) {
        return resp.json({ message: [`Sorry no booking found with this booking id ${booking_id}`], status: 0, code: 404 });
    }
    const ordHistoryCount = await queryDB(
        'SELECT COUNT(*) as count FROM charging_service_history WHERE rsa_id = ? AND order_status = "WC" AND service_id = ?',[rsa_id, booking_id]
    );

    if (ordHistoryCount.count === 0) {
        const insert = await db.execute(
            'INSERT INTO charging_service_history (service_id, rider_id, order_status, rsa_id, latitude, longitude, image) VALUES (?, ?, "WC", ?, ?, ?, ?)',
            [booking_id, checkOrder.rider_id, rsa_id, latitude, longitude, imgName]
        );

        if(insert.affectedRows == 0) return resp.json({ message: ['Oops! Something went wrong! Please Try Again'], status: 0, code: 200 });

        await updateRecord('charging_service', {order_status: 'WC', rsa_id}, ['request_id'], [booking_id]);
        await db.execute(`DELETE FROM charging_service_assign WHERE rsa_id=? AND order_id = ?`, [rsa_id, booking_id]);
        // await db.execute('UPDATE rsa SET running_order = running_order - 1 WHERE rsa_id = ?', [rsa_id]);
        // await db.execute('UPDATE pick_drop_slot SET booking_limit = booking_limit + 1 WHERE slot_id = ?', [checkOrder.slot_id]);

        const data = await queryDB(`
            SELECT 
                csi.invoice_id, ROUND(csi.amount/100, 2) AS amount, csi.invoice_date, cs.name, cs.request_id,
                CASE WHEN csi.currency IS NOT NULL THEN UPPER(csi.currency) ELSE 'AED' END AS currency, 
                (SELECT rd.rider_email FROM riders AS rd WHERE rd.rider_id = csi.rider_id) AS rider_email
            FROM 
                charging_service_invoice AS csi
            LEFT JOIN
                charging_service AS cs ON cs.request_id = csi.request_id
            WHERE 
                csi.invoice_id = ?
            LIMIT 1
        `, [invoiceId]);
        data.invoice_date = data.invoice_date ? moment(data.invoice_date).format('MMM D, YYYY') : '';
        data.amount       =  Number(parseFloat(data.amount));
        
        const invoiceData  = { data, numberToWords, formatNumber  };
        const templatePath = path.join(__dirname, '../../views/mail/pick-and-drop-invoice.ejs'); 
        const filename     = `${invoiceId}-invoice.pdf`;
        const savePdfDir   = 'pick-drop-invoice';

        const pdf = await generatePdf(templatePath, invoiceData, filename, savePdfDir, req);

        if(pdf.success){
            const html = `<html>
                <body>
                    <h4>Dear ${data.name}</h4>
                    <p>We hope you are doing well!</p>
                    <p>Thank you for choosing our EV pickup and drop-off service for your vehicle. We are pleased to inform you that your booking has been successfully completed, and the details of your invoice are attached.</p>
                    <p>We appreciate your trust in PlusX Electric and look forward to serving you again.</p>
                    <p>Best Regards,<br/> PlusX Electric Team </p>
                </body>
            </html>`;
            const attachment = {
                filename: `${invoiceId}-invoice.pdf`, path: pdf.pdfPath, contentType: 'application/pdf'
            }
            emailQueue.addEmail(data.rider_email, 'PlusX Electric: Invoice for Your EV Pickup and Drop-off Service', html, attachment);
        }

        return resp.json({ message: ['Work completed! successfully!'], status: 1, code: 200 });
    } else {
        return resp.json({ message: ['Sorry this is a duplicate entry!'], status: 0, code: 200 });
    }
};

/* User Booking Cancel */
export const cancelValetBooking = asyncHandler(async (req, resp) => {
    const { rider_id, booking_id, reason='' } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {rider_id: ["required"], booking_id: ["required"] });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
    
    const checkOrder = await queryDB(`
        SELECT 
            name, rsa_id, DATE_FORMAT(slot_date_time, '%Y-%m-%d %H:%i:%s') AS slot_date_time,
            CONCAT( country_code, "-", contact_no) as contact_no, 
            (SELECT rd.rider_email FROM riders AS rd WHERE rd.rider_id = cs.rider_id) AS rider_email,
            (SELECT rd.rider_name FROM riders AS rd WHERE rd.rider_id = cs.rider_id) AS rider_name,
            (SELECT fcm_token FROM riders WHERE rider_id = cs.rider_id) AS fcm_token,
            (select fcm_token from rsa where rsa.rsa_id = cs.rsa_id ) as rsa_fcm_token
        FROM 
            charging_service AS cs
        WHERE 
            request_id = ? AND rider_id = ? AND order_status IN ('CNF','A','ER') 
        LIMIT 1
    `,[booking_id, rider_id]);

    if (!checkOrder) {
        return resp.json({ message: [`Sorry no booking found with this booking id ${booking_id}`], status: 0, code: 404 });
    }
    
    const insert = await db.execute(
        'INSERT INTO charging_service_history (service_id, rider_id, order_status, rsa_id, cancel_by, cancel_reason) VALUES (?, ?, "C", ?, "User", ?)',
        [booking_id, rider_id, checkOrder.rsa_id, reason]
    );
    if(insert.affectedRows == 0) return resp.json({ message: ['Oops! Something went wrong! Please Try Again'], status: 0, code: 200 });

    await updateRecord('charging_service', {order_status: 'C'}, ['request_id'], [booking_id]);
    
    const href    = `charging_service/${booking_id}`;
    const title   = 'Valet Service Cancel!';
    const message = `Pickup and Drop Off EV Charging : Booking ID ${booking_id} - ${checkOrder.rider_name} cancelled the booking.`;
    await createNotification(title, message, 'Charging Service', 'Admin', 'Rider', rider_id, '', href);


    if( checkOrder.rsa_id) {
        await db.execute(`DELETE FROM charging_service_assign WHERE rider_id=? AND order_id = ?`, [rider_id, booking_id]);
        await db.execute('UPDATE rsa SET running_order = running_order - 1 WHERE rsa_id = ?', [checkOrder.rsa_id]);
    }

    const html = `<html>
        <body>
            <h4>Dear ${checkOrder.rider_name},</h4>
            <p>We would like to inform you that your booking for the EV Pickup and Drop Off charging service has been successfully cancelled. Below are the details of your cancelled booking:</p>
            Booking ID    : ${booking_id}<br>
            Date and Time : ${moment(checkOrder.slot_date_time, 'YYYY-MM-DD HH:mm:ss').format('D MMM, YYYY, h:mm A')}
            <p>If this cancellation was made in error or if you wish to reschedule, please feel free to reach out to us. We're happy to assist you.</p>
            <p>Thank you for using PlusX Electric. We hope to serve you again soon.</p>
            <p>Best regards,<br/>PlusX Electric Team </p>
        </body>
    </html>`;
    emailQueue.addEmail(checkOrder.rider_email, `PlusX Electric App: Booking Cancellation`, html);

    const adminHtml = `<html>
        <body>
            <h4>Dear Admin,</h4>
            <p>This is to notify you that a customer has canceled their PlusX Electric Pickup and Drop-Off EV Charging Service booking. Please find the details below:</p>
            <p>Booking Details:</p>
            Name         : ${checkOrder.name}<br>
            Contact      : ${checkOrder.contact_no}<br>
            Booking ID   : ${booking_id}<br>
            Booking Date : ${checkOrder.slot_date_time}<br> 
            Reason       : ${checkOrder.cancel_reason}<br>
            <p>Thank you,<br/>PlusX Electric Team </p>
        </body>
    </html>`;
    emailQueue.addEmail(process.env.MAIL_CS_ADMIN, `Pickup & Drop-Off Charging Service : Booking Cancellation `, adminHtml);

    return resp.json({ message: ['Booking has been cancelled successfully!'], status: 1, code: 200 });
});

// ye new bana hai 
const valetChargerInvoice = async (rider_id, request_id ) => {
    // console.log(rider_id, request_id)
    try {
        const checkOrder = await queryDB(` SELECT payment_intent_id
            FROM 
                charging_service 
            WHERE 
                request_id = ? AND rider_id = ?
            LIMIT 1
        `,[request_id, rider_id]);
        // console.log(checkOrder)
        if (!checkOrder) {
            return { status : 0  };
        }
        const payment_intent_id = checkOrder.payment_intent_id;
        const invoiceId = request_id.replace('CS', 'INVCS');
        const createObj = {
            invoice_id     : invoiceId,
            request_id     : request_id,
            rider_id       : rider_id,
            invoice_date   : moment().format('YYYY-MM-DD HH:mm:ss'),
            payment_status : 'Approved'
        }
        if(payment_intent_id && payment_intent_id.trim() != '' ){
            const paymentIntent = await stripe.paymentIntents.retrieve(payment_intent_id);
            const charge = await stripe.charges.retrieve(paymentIntent.latest_charge);
            const cardData = {
                brand     : charge.payment_method_details.card.brand,
                country   : charge.payment_method_details.card.country,
                exp_month : charge.payment_method_details.card.exp_month,
                exp_year  : charge.payment_method_details.card.exp_year,
                last_four : charge.payment_method_details.card.last4,
            };
            createObj.amount            = charge.amount;  
            createObj.payment_intent_id = charge.payment_intent;  
            createObj.payment_method_id = charge.payment_method;  
            createObj.payment_cust_id   = charge.customer;  
            createObj.charge_id         = charge.id;  
            createObj.transaction_id = charge.payment_method_details.card.three_d_secure?.transaction_id || null;  
            createObj.payment_type = charge.payment_method_details.type;  
            createObj.currency     = charge.currency;  
            createObj.invoice_date = moment.unix(charge.created).format('YYYY-MM-DD HH:mm:ss');
            createObj.receipt_url  = charge.receipt_url;
            createObj.card_data    = cardData;
        }
        const columns = Object.keys(createObj);
        const values  = Object.values(createObj);
        const insert  = await insertRecord('charging_service_invoice', columns, values);
        // console.log('insert', insert)
        return { status: (insert.affectedRows > 0) ? 1 : 0 };
        
    } catch (error) {
        console.log('error', error)
        return { status:0  };
    }
};

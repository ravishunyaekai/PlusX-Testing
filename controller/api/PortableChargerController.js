import path from 'path';
import moment from "moment-timezone";
import dotenv from 'dotenv';
import 'moment-duration-format';
import { fileURLToPath } from 'url';
import emailQueue from "../../emailQueue.js";
import validateFields from "../../validation.js";
import { queryDB, getPaginatedData, insertRecord, updateRecord } from '../../dbUtils.js';
import db, { startTransaction, commitTransaction, rollbackTransaction } from "../../config/db.js";
import { asyncHandler, createNotification, formatDateInQuery, formatDateTimeInQuery, formatNumber, generatePdf, mergeParam, numberToWords, pushNotification } from "../../utils.js";
import { createAutoDebit, getTotalAmountFromService } from '../PaymentController.js';
dotenv.config();
import Stripe from "stripe";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

export const chargerList = asyncHandler(async (req, resp) => {
    const {rider_id, page_no } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {rider_id: ["required"], page_no: ["required"]});
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const result = await getPaginatedData({
        tableName  : 'portable_charger',
        columns    : 'charger_id, charger_name, charger_price, charger_feature, image, charger_type',
        sortColumn : 'id',
        sortOrder  : 'ASC',
        page_no,
        limit      : 10,
        whereField : ['status'],
        whereValue : ['1']
    });

    const [slotData] = await db.execute(`SELECT slot_id, start_time, end_time, booking_limit FROM portable_charger_slot WHERE status = ?`, [1]);

    return resp.json({
        status: 1,
        code: 200,
        message: ["Portable Charger List fetch successfully!"],
        data: result.data,
        slot_data: slotData,
        total_page: result.totalPage,
        total: result.total,
        base_url: `${req.protocol}://${req.get('host')}/uploads/portable-charger/`,
    });
});

export const getActivePodList = asyncHandler(async (req, resp) => {
    const { booking_id, booking_type } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), { booking_id: ["required"], booking_type: ["required"]});
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
    if (!['PCB', 'CS'].includes(booking_type)) return resp.json({status:0, code:422, message:["Booking type should be PCB or CS"]});

    let query;
    if(booking_type === 'PCB'){
        query = `SELECT latitude AS lat, longitude AS lon FROM portable_charger_booking WHERE booking_id = ?`;
    }else if(booking_type === 'CS'){
        query = `SELECT pickup_latitude AS lat, pickup_longitude AS lon FROM charging_service WHERE request_id = ?`;
    }

    const data = await queryDB(query, [booking_id]);
    const [[{pod_id}]] = await db.execute(`SELECT pod_id FROM portable_charger_booking where booking_id = ?`, [booking_id]);
    if(!data) return resp.json({status:0, code:422, message:"Invalid id."});

    const [result] = await db.execute(`SELECT 
        pod_id, pod_name, design_model,
        (6367 * ACOS(COS(RADIANS(?)) * COS(RADIANS(latitude)) * COS(RADIANS(longitude) - RADIANS(?)) + SIN(RADIANS(?)) * SIN(RADIANS(latitude)))) AS distance 
        FROM pod_devices
        ORDER BY CAST(SUBSTRING(pod_name, LOCATE(' ', pod_name) + 1) AS UNSIGNED)
    `, [data.lat, data.lon, data.lat]);

    return resp.json({status:1, code:200, message:["POD List fetch successfully!"], active_pod_id: pod_id, data: result });
    // return resp.json({status:1, code:200, message:["POD List fetch successfully!"], data: result });
});

export const getPcSlotList = asyncHandler(async (req, resp) => {
    const { slot_date, rider_id } = mergeParam(req);
    if(!slot_date) return resp.json({status : 0, code : 422, message : ['slot date is required']});
    
    const fSlotDate = moment(slot_date, 'YYYY-MM-DD').format('YYYY-MM-DD');

    let query = `SELECT slot_id, ${formatDateInQuery([('slot_date')])}, start_time, end_time, booking_limit`;
    
    if(fSlotDate >=  moment().format('YYYY-MM-DD')){
        query += `,(SELECT COUNT(id) FROM portable_charger_booking AS pod WHERE pod.slot=portable_charger_slot.slot_id AND pod.slot_date='${slot_date}' AND status NOT IN ("PU", "C")) AS slot_booking_count`;
    }
    query += ` FROM portable_charger_slot WHERE status = ? AND slot_date = ? ORDER BY start_time ASC`;
    
    const [slot] = await db.execute(query, [1, fSlotDate]);
    // const {is_booking} = await queryDB(`SELECT EXISTS (SELECT 1 FROM portable_charger_booking WHERE slot_date=? AND status NOT IN ("C") AND rider_id=? ) AS is_booking`, [fSlotDate, rider_id]);

    if(moment(fSlotDate).day() === 0){
        slot.forEach((val) => {
            val.booking_limit      = 0;
            val.slot_booking_count = 0;
        })
    } 
    const [[lastBookingData]] = await db.execute(`SELECT status, ${formatDateTimeInQuery(['created_at'])} FROM portable_charger_booking WHERE rider_id = ? order by id desc limit 1 `, [rider_id]);

    let bookingPrice = 1;
    if(lastBookingData.status == 'C' ) {
        let timeZone = moment().tz("Asia/Dubai");
        let prevDay  = timeZone.subtract(24, 'hours').format('YYYY-MM-DD HH:mm:ss');
        bookingPrice = ( lastBookingData.created_at > prevDay ) ? 0 : bookingPrice;
    }
    return resp.json({ 
        message    : "Slot List fetch successfully!",  
        data       : slot, 
        is_booking : 0, 
        status     : 1, 
        code       : 200, 
        alert      : "",
        alert2     : "The slots for the selected date are fully booked. Please select another date to book the POD for your EV.", 
        booking_price : bookingPrice
    });
});

export const chargerBooking = asyncHandler(async (req, resp) => {
    const { 
        rider_id, charger_id, vehicle_id, service_name, service_type, service_feature, user_name, country_code, contact_no, address, latitude, longitude, slot_date, slot_time, slot_id, service_price = ''
    } = mergeParam(req);

    const { isValid, errors } = validateFields(mergeParam(req), {
        rider_id        : ["required"],
        charger_id      : ["required"],
        vehicle_id      : ["required"],
        service_name    : ["required"],
        service_type    : ["required"],
        service_feature : ["required"],
        user_name       : ["required"],
        country_code    : ["required"],
        contact_no      : ["required"],
        address         : ["required"],
        latitude        : ["required"],
        longitude       : ["required"],
        slot_date       : ["required"],
        slot_time       : ["required"],
    });   
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const conn = await startTransaction();
    try{
        const fSlotDateTime = moment(slot_date + ' ' + slot_time, 'YYYY-MM-DD HH:mm:ss').format('YYYY-MM-DD HH:mm:ss')
        const currDateTime = moment().utcOffset(4).format('YYYY-MM-DD HH:mm:ss');
        if (fSlotDateTime < currDateTime) return resp.json({status: 0, code: 422, message: ["Invalid slot, Please select another slot"]});
        
        const fSlotDate = moment(slot_date, 'YYYY-MM-DD').format('YYYY-MM-DD');
        const currDate  = moment().format('YYYY-MM-DD');
        let timeZone    = moment().tz("Asia/Dubai");
        let prevDay     = timeZone.subtract(28, 'hours').format('YYYY-MM-DD HH:mm:ss');

        // (SELECT COUNT(id) FROM portable_charger_booking as pod where pod.slot_date=? AND status NOT IN ("C") AND rider_id=?) as today_count
        // fcm_token, rider_email, 
        const rider = await queryDB(` 
            SELECT 
                (SELECT MAX(id) FROM portable_charger_booking) AS last_index,
                (SELECT COUNT(id) FROM portable_charger AS pc WHERE pc.charger_id = ?) AS charg_count,
                (SELECT booking_limit FROM portable_charger_slot AS pcs WHERE pcs.slot_date = ? and pcs.start_time = ?) AS booking_limit,
                (SELECT COUNT(id) FROM portable_charger_booking as pod where pod.slot_time=? and pod.slot_date=? and status NOT IN ("PU", "C", "RO") ) as slot_booking_count,
                (SELECT address_alert FROM portable_charger_booking as pod1 where pod1.rider_id=? and pod1.address=? order by id desc limit 1 ) as alert_add,
                (SELECT CONCAT(status, "_",  created_at) FROM portable_charger_booking as pod2 WHERE pod2.rider_id = ? order by id desc limit 1 ) AS last_booking
            FROM 
                riders AS r
            WHERE 
                r.rider_id = ?
        `, [charger_id, 
            fSlotDate, slot_time, 
            slot_time, fSlotDate, 
            rider_id, address,
            rider_id,
            rider_id], conn);
    
        const { charg_count, booking_limit, slot_booking_count, alert_add, last_booking } = rider; 
        //,today_count
    
        if (charg_count === 0) return resp.json({ message: ["Charger Id invalid!"], status: 0, code: 405, error: true });
        //if ( today_count > 0 ) return resp.json({ message: ["Note: Only one EV charging booking is allowed per day. Plan your charging accordingly!"], status: 0, code: 405, error: true });
        if ( slot_booking_count >= booking_limit ) return resp.json({ message: ["Booking Slot Full!, please select another slot"], status: 0, code: 405, error: true });
    
        if (service_type.toLowerCase() === "get monthly subscription") {
            const [subsCountRows] = await db.execute(`SELECT COUNT(*) AS count FROM portable_charger_subscription WHERE rider_id = ? AND (total_booking >= 10 OR expiry_date < ?)`, 
                [rider_id, currDate]
            );
            const subsCount = subsCountRows[0].count;
            if (subsCount > 0) { 
                return resp.json({ message: ["Subscription limit exceeded or expired!"], status: 0, code: 405, error: true });
            }
        }
        const start      = (!rider.last_index) ? 0 : rider.last_index; 
        const nextId     = start + 1;
        const bookingId  = 'PCB' + String(nextId).padStart(4, '0');

        let servicePrice = service_price;
        if(last_booking && last_booking.split("_")[0] == 'C') {

            // let last_status = last_booking.split("_")[0] ;
            // if(last_status == 'C' ) {
                let last_created_at     = last_booking.split("_")[1] ;
                let new_last_created_at = moment(last_created_at).format('YYYY-MM-DD HH:mm:ss');

                let timeZone = moment().tz("Asia/Dubai");
                let prevDay  = timeZone.subtract(28, 'hours').format('YYYY-MM-DD HH:mm:ss');

                servicePrice = ( new_last_created_at > prevDay ) ? 0 : servicePrice;
            // }
        }
        const insert = await insertRecord('portable_charger_booking', [
            'booking_id', 'rider_id', 'charger_id', 'vehicle_id', 'service_name', 'service_price', 'service_type', 'service_feature', 'user_name', 'country_code', 
            'contact_no', 'slot', 'slot_date', 'slot_time', 'address', 'latitude', 'longitude', 'status', 'address_alert' 
        ], [
            bookingId, rider_id, charger_id, vehicle_id, service_name, servicePrice, service_type, service_feature, user_name, country_code, contact_no,
            slot_id, fSlotDate, slot_time, address, latitude, longitude, 'PNR', alert_add
        ], conn);
    
        if(insert.affectedRows == 0) return resp.json({status:0, code:200, message: ["Oops! Something went wrong. Please try again."]});
        
        // if(coupon_code){
        //     const coupon = await queryDB(`SELECT coupan_percentage FROM coupon WHERE coupan_code = ? LIMIT 1 `, [ coupon_code ]); 

        //     let coupan_percentage = coupon.coupan_percentage ;
        //     await insertRecord('coupon_usage', ['coupan_code', 'user_id', 'booking_id', 'coupan_percentage'], [coupon_code, rider_id, bookingId, coupan_percentage], conn);
        // }
        // if (service_type.toLowerCase() === "get monthly subscription") {
        //     await conn.execute('UPDATE portable_charger_subscriptions SET total_booking = total_booking + 1 WHERE rider_id = ?', [rider_id]);
        // }
        // await insertRecord('portable_charger_history', ['booking_id', 'rider_id', 'order_status'], [bookingId, rider_id, 'CNF'], conn);
        
        // const href    = 'portable_charger_booking/' + bookingId;
        // const heading = 'Portable Charging Booking!';
        // const desc    = `Booking Confirmed! ID: ${bookingId}.`;
        // createNotification(heading, desc, 'Portable Charging Booking', 'Rider', 'Admin','', rider_id, href);
        // createNotification(heading, desc, 'Portable Charging Booking', 'Admin', 'Rider',  rider_id, '', href);
        // pushNotification(rider.fcm_token, heading, desc, 'RDRFCM', href);
    
        // const formattedDateTime =  moment().utcOffset('+04:00').format('DD MMM YYYY hh:mm A');
        // const htmlUser = `<html>
        //     <body>
        //         <h4>Dear ${user_name},</h4>
        //         <p>Thank you for choosing our portable charger service for your EV. We are pleased to confirm that your booking has been successfully received.</p> 
        //         <p>Booking Details:</p>
        //         Booking ID: ${bookingId}<br>
        //         Date and Time of Service: ${moment(slot_date, 'YYYY MM DD').format('D MMM, YYYY,')} ${moment(slot_time, 'HH:mm').format('h:mm A')}<br>
        //         <p>We look forward to serving you and providing a seamless EV charging experience.</p>                  
        //         <p> Best regards,<br/>PlusX Electric Team </p>
        //     </body>
        // </html>`;
        // emailQueue.addEmail(rider.rider_email, 'PlusX Electric App: Booking Confirmation for Your Portable EV Charger', htmlUser);
        // const vechile = await queryDB(`SELECT CONCAT(vehicle_make, "-", vehicle_model) AS vehicle_data FROM riders_vehicles WHERE vehicle_id = ?`, [vehicle_id]);
        // const htmlAdmin = `<html>
        //     <body>
        //         <h4>Dear Admin,</h4>
        //         <p>We have received a new booking for our Portable Charger service. Below are the details:</p> 
        //         Customer Name   : ${user_name}<br>
        //         Contact No.     : ${country_code}-${contact_no}<br>
        //         Address         : ${address}<br>
        //         Booking Time    : ${formattedDateTime}<br>                    
        //         Schedule Time   : ${moment(slot_date, 'YYYY MM DD').format('D MMM, YYYY,')} ${moment(slot_time, 'HH:mm').format('h:mm A')}<br>                    
        //         Vechile Details : ${vechile.vehicle_data}<br> 
        //         <a href="https://www.google.com/maps?q=${latitude},${longitude}">Address Link</a><br>
        //         <p> Best regards,<br/>PlusX Electric Team </p>
        //     </body>
        // </html>`;
        // emailQueue.addEmail(process.env.MAIL_POD_ADMIN, `Portable Charger Booking - ${bookingId}`, htmlAdmin);
       
        // let respMsg = "Booking Request Received! Thank you for booking our portable charger service for your EV. Our team will arrive at the scheduled time."; 
        
        // const rsa = await queryDB(`SELECT fcm_token, rsa_id FROM rsa WHERE status = ? AND booking_type = ?`, [2, 'Portable Charger']);
        // if(rsa){
        //     const slotDateTime = moment(`${slot_date} ${slot_time}`, 'YYYY-MM-DD HH:mm:ss').format('YYYY-MM-DD HH:mm:ss');
        //     await insertRecord('portable_charger_booking_assign', 
        //         ['order_id', 'rsa_id', 'rider_id', 'slot_date_time', 'status'], [bookingId, rsa.rsa_id, rider_id, slotDateTime, 0], conn
        //     );
        //     await updateRecord('portable_charger_booking', {rsa_id: rsa.rsa_id}, ['booking_id'], [bookingId], conn);
        //     const heading1 = 'Portable Charger!';
        //     const desc1 = `A Booking of the Portable Charger service has been assigned to you with booking id : ${bookingId}`;
        //     createNotification(heading, desc, 'Portable Charger', 'RSA', 'Rider', rider_id, rsa.rsa_id, href);
        //     pushNotification(rsa.fcm_token, heading1, desc1, 'RSAFCM', href);
        // }

        await commitTransaction(conn);
        return resp.json({
            status        : 1, 
            code          : 200,
            booking_id    : bookingId,
            service_price : servicePrice,
            message       : ["Booking Request Received!."] 
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

export const chargerBookingList = asyncHandler(async (req, resp) => {
    const {rider_id, page_no, history } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {rider_id: ["required"], page_no: ["required"]});
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const limit           = 10;
    const start           = ( page_no * limit ) - limit;
    const statusCondition = (history && history == 1) ? `status IN (?, ?, ?)` : `status NOT IN (?, ?, ?, ?)`;
    const statusParams    = (history && history == 1) ? ['PU', 'C', 'RO' ] : ['PU', 'C', 'RO', 'PNR'];

    const totalQuery = `SELECT COUNT(*) AS total FROM portable_charger_booking WHERE rider_id = ? AND ${statusCondition}`;
    const [totalRows] = await db.execute(totalQuery, [rider_id, ...statusParams]);
    const total       = totalRows[0].total;
    const totalPage   = Math.max(Math.ceil(total / limit), 1);

    const bookingsQuery = `SELECT booking_id, service_name, ROUND(portable_charger_booking.service_price/100, 2) AS service_price, service_type, user_name, country_code, contact_no, slot_time, status, 
        ${formatDateTimeInQuery(['created_at'])}, ${formatDateInQuery(['slot_date'])}
        FROM portable_charger_booking WHERE rider_id = ? AND ${statusCondition} ORDER BY id DESC LIMIT ${parseInt(start)}, ${parseInt(limit)}
    `;
   
    const [bookingList] = await db.execute(bookingsQuery, [rider_id, ...statusParams]);

    return resp.json({
        message    : ["Portable Charger Booking List fetched successfully!"],
        data       : bookingList,
        total_page : totalPage,
        status     : 1,
        code       : 200,
        base_url   : `${req.protocol}://${req.get('host')}/uploads/portable-charger/`,
    });
});

export const chargerBookingDetail = asyncHandler(async (req, resp) => {
    const {rider_id, booking_id } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {rider_id: ["required"], booking_id: ["required"]});
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const booking = await queryDB(`SELECT portable_charger_booking.*, ROUND(portable_charger_booking.service_price / 100, 2) AS service_price, (select concat(vehicle_make, "-", vehicle_model) from riders_vehicles as rv where rv.vehicle_id = portable_charger_booking.vehicle_id limit 1) as vehicle_data, ${formatDateTimeInQuery(['created_at', 'updated_at'])}, ${formatDateInQuery(['slot_date'])} FROM portable_charger_booking WHERE rider_id = ? AND booking_id = ? LIMIT 1`, [rider_id, booking_id]);

    if (booking && ( booking.status == 'PU' || booking.status == 'RO' ) ) {
        const invoice_id = booking.booking_id.replace('PCB', 'INVPC');
        booking.invoice_url = `${req.protocol}://${req.get('host')}/public/portable-charger-invoice/${invoice_id}-invoice.pdf`;
    }
    // const [history] = await db.execute(`SELECT *, ROUND(portable_charger_booking.service_price / 100, 2) AS service_price FROM portable_charger_booking WHERE booking_id = ?`, [booking_id]);
    const [history] = await db.execute(`
        SELECT 
            order_status, cancel_by, cancel_reason as reason, rsa_id, ${formatDateTimeInQuery(['created_at'])}, image, remarks,   
            (select rsa.rsa_name from rsa where rsa.rsa_id = portable_charger_history.rsa_id) as rsa_name
        FROM 
            portable_charger_history 
        WHERE 
            booking_id = ?`, 
        [booking_id]
    );
    return resp.json({
        message         : ["Charging Installation Service fetched successfully!"],
        data            : booking,
        service_history : history,
        status          : 1,
        code            : 200,
    });
});

export const getPcSubscriptionList = asyncHandler(async (req, resp) => {
    const { rider_id } = mergeParam(req);
    if(!rider_id) return resp.json({status: 0, code: 200, error: true, message: ["Rider Id is required"]});

    const data = await queryDB(`
        SELECT subscription_id, amount, expiry_date, booking_limit, total_booking, payment_date 
        FROM portable_charger_subscriptions WHERE rider_id = ? ORDER BY id DESC
    `, [rider_id]);

    if(data?.amount){
        data.amount /= 100; 
    }
    const sPrice = (data && data.expiry_date > moment().format("YYYY-MM-DD") && data.total_booking >= 10) ? 75 : 750;

    return resp.json({
        message: [ "Subscription Details fetch successfully!" ],
        data: data,
        status: 1,
        subscription_price: sPrice,
        code: 200,
        subscription_img: `${req.protocol}://${req.get('host')}/public/pod-no-subscription.jpeg`,
    });
});

/* Invoice */
export const invoiceList = asyncHandler(async (req, resp) => {
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
        tableName : 'portable_charger_invoice',
        columns   : `invoice_id, amount, payment_status, invoice_date, currency, 
            (select concat(name, ",", country_code, "-", contact_no) from portable_charger_booking as pcb where pcb.booking_id = portable_charger_invoice.request_id limit 1)
            AS riderDetails`,
        sortColumn : 'id',
        sortOrder  : 'DESC',
        page_no,
        limit   : 10,
        whereField,
        whereValue
    });

    return resp.json({
        status     : 1,
        code       : 200,
        message    : ["Pick & Drop Invoice List fetch successfully!"],
        data       : result.data,
        total_page : result.totalPage,
        total      : result.total,
        base_url   : `${req.protocol}://${req.get('host')}/uploads/offer/`,
    });
});
export const invoiceDetails = asyncHandler(async (req, resp) => {
    const {rider_id, invoice_id } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {rider_id: ["required"], invoice_id: ["required"]});
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const invoice = await queryDB(`SELECT 
        invoice_id, amount as price, payment_status, invoice_date, currency, payment_type, pcb.user_name, pcb.country_code, pcb.contact_no, pcb.address, pcb.booking_id, 
        cs.slot_date, pcb.slot_time, (select rider_email from riders as rd where rd.rider_id = portable_charger_invoice.rider_id limit 1) as rider_email'
        FROM 
            portable_charger_invoice AS pci
        LEFT JOIN
            portable_charger_booking AS pcb ON pcb.booking_id = pci.request_id
        LEFT JOIN 
            portable_charger_slot AS cs ON cs.slot_id = pcb.slot
        WHERE 
            pci.invoice_id = ?
    `, [invoice_id]);

    invoice.invoice_url = `${req.protocol}://${req.get('host')}/uploads/portable-charger-invoice/${invoice_id}-invoice.pdf`;

    return resp.json({
        message : ["Pick & Drop Invoice Details fetch successfully!"],
        data    : invoice,
        status  : 1,
        code    : 200,
    });
});

/* RSA - Booking Action */
export const rsaBookingStage = asyncHandler(async (req, resp) => {
    const {rsa_id, booking_id } = mergeParam(req);
    const { isValid, errors }   = validateFields(mergeParam(req), {rsa_id: ["required"], booking_id: ["required"]});
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const booking = await queryDB(`SELECT status, created_at, updated_at FROM portable_charger_booking WHERE booking_id=?`, [booking_id]);
    if(!booking) return resp.json({status:0, code:200, message: "Sorry no data found with given order id: " + booking_id});

    const orderStatus = ['CNF','A','RL','CS','CC','PU','C'];
    const placeholders = orderStatus.map(() => '?').join(', ');

    const [bookingTracking] = await db.execute(`SELECT order_status, remarks, image, cancel_reason, cancel_by, longitude, latitude FROM portable_charger_history 
        WHERE booking_id = ? AND rsa_id = ? AND order_status IN (${placeholders})
    `, [booking_id, rsa_id, ...orderStatus]);

    const seconds               = Math.floor((booking.updated_at - booking.created_at) / 1000);
    const humanReadableDuration = moment.duration(seconds, 'seconds').format('h [hours], m [minutes]');
    
    return resp.json({
        status          : 1,
        code            : 200,
        message         : ["Booking stage fetch successfully."],
        booking_status  : booking.status,
        execution_time  : humanReadableDuration,
        booking_history : bookingTracking,
        image_path      : `${req.protocol}://${req.get('host')}/uploads/portable-charger/`
    });
});

export const bookingAction = asyncHandler(async (req, resp) => {  
    const {rsa_id, booking_id, reason, latitude, longitude, booking_status, pod_id} = req.body;
    let validationRules = {
        rsa_id         : ["required"], 
        booking_id     : ["required"], 
        latitude       : ["required"], 
        longitude      : ["required"], 
        booking_status : ["required"],
    };
    if (booking_status == "C")  validationRules = { ...validationRules, reason  : ["required"] };
    // if (booking_status == "CS") validationRules = { ...validationRules, pod_id  : ["required"] };

    const { isValid, errors } = validateFields(req.body, validationRules);
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    switch (booking_status) {
        case 'A' : return await acceptBooking(req, resp);
        case 'ER': return await driverEnroute(req, resp);
        case 'RL': return await reachedLocation(req, resp);
        case 'CS': return await chargingStart(req, resp);
        case 'CC': return await chargingComplete(req, resp);
        case 'PU': return await chargerPickedUp(req, resp);
        case 'RO': return await reachedOffice(req, resp);
        default: return resp.json({status: 0, code: 200, message: ['Invalid booking status.']});
    }
});

export const rejectBooking = asyncHandler(async (req, resp) => {
    const {rsa_id, booking_id, reason } = mergeParam(req); // latitude, longitude,
    const { isValid, errors } = validateFields(mergeParam(req), {rsa_id: ["required"], booking_id: ["required"], reason: ["required"]});
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const checkOrder = await queryDB(`
        SELECT rider_id, 
            (SELECT fcm_token FROM riders WHERE rider_id = portable_charger_booking_assign.rider_id limit 1) AS fcm_token
        FROM 
            portable_charger_booking_assign
        WHERE 
            order_id = ? AND rsa_id = ? AND status = 0
        LIMIT 1
    `,[booking_id, rsa_id]);

    if (!checkOrder) {
        return resp.json({ message: [`Sorry no booking found with this booking id ${booking_id}`], status: 0, code: 404 });
    }

    const insert = await db.execute(
        'INSERT INTO portable_charger_history (booking_id, rider_id, order_status, rsa_id) VALUES (?, ?, "C", ?)',
        [booking_id, checkOrder.rider_id, rsa_id ]
    );
    if(insert.affectedRows == 0) return resp.json({ message: ['Oops! Something went wrong! Please Try Again'], status: 0, code: 200 });

    await insertRecord('portable_charger_booking_rejected', ['booking_id', 'rsa_id', 'rider_id', 'reason'],[booking_id, rsa_id, checkOrder.rider_id, reason]);
    await db.execute(`DELETE FROM portable_charger_booking_assign WHERE order_id=? AND rsa_id=?`, [booking_id, rsa_id]);

    const href    = `portable_charger_booking/${booking_id}`;
    const title   = 'Booking Rejected';
    const message = `Driver has rejected the portable charger booking with booking id: ${booking_id}`;
    await createNotification(title, message, 'Portable Charging', 'Rider', 'RSA', rsa_id, checkOrder.rider_id, href);

    /* const html = `<html>
        <body>
            <h4>Dear Admin,</h4>
            <p>Driver has rejected the portable charger booking. please assign one Driver on this booking</p> <br />
            <p>Booking ID: ${booking_id}</p>
            <p>Best Regards,<br/> The PlusX Electric Team </p>
        </body>
    </html>`;
    emailQueue.addEmail(process.env.MAIL_POD_ADMIN, `POD Service Booking rejected - ${booking_id}`, html); */

    return resp.json({ message: ['Booking has been rejected successfully!'], status: 1, code: 200 });
});

/* POD booking action helper */
const acceptBooking = async (req, resp) => {
    const { booking_id, rsa_id, latitude, longitude } = mergeParam(req);

    //, (SELECT COUNT(id) FROM portable_charger_booking_assign WHERE rsa_id = ? AND status = 1) AS pod_count
    const checkOrder = await queryDB(`
        SELECT rider_id, 
            (SELECT fcm_token FROM riders WHERE rider_id = portable_charger_booking_assign.rider_id limit 1) AS fcm_token
        FROM 
            portable_charger_booking_assign
        WHERE 
            order_id = ? AND rsa_id = ? AND status = 0
        LIMIT 1
    `,[booking_id, rsa_id]);

    if (!checkOrder) {
        return resp.json({ message: [`Sorry no booking found with this booking id ${booking_id}`], status: 0, code: 404 });
    }
    // if (checkOrder.pod_count > 0) {
    //     return resp.json({ message: ['You have already one booking, please complete that first!'], status: 0, code: 404 });
    // }

    const ordHistoryCount = await queryDB(
        'SELECT COUNT(*) as count FROM portable_charger_history WHERE rsa_id = ? AND order_status = "A" AND booking_id = ?',[rsa_id, booking_id]
    );

    if (ordHistoryCount.count === 0) {
        await updateRecord('portable_charger_booking', {status: 'A', rsa_id}, ['booking_id'], [booking_id]);

        const href    = `portable_charger_booking/${booking_id}`;
        const title   = 'POD Booking Accepted';
        const message = `Booking Accepted! ID: ${booking_id}.`;
        await createNotification(title, message, 'Portable Charging', 'Rider', 'RSA', rsa_id, checkOrder.rider_id, href);
        await pushNotification(checkOrder.fcm_token, title, message, 'RDRFCM', href);

        await db.execute('UPDATE portable_charger_booking_assign SET status = 1 WHERE order_id = ? AND rsa_id = ?', [booking_id, rsa_id]);
        const insert = await insertRecord('portable_charger_history', [
            'booking_id', 'rider_id', 'order_status', 'rsa_id', 'latitude', 'longitude'
        ],[
            booking_id, checkOrder.rider_id, "A", rsa_id, latitude, longitude
        ]);
        if(insert.affectedRows == 0) return resp.json({ message: ['Oops! Something went wrong! Please Try Again'], status: 0, code: 200 });

        // await db.execute('UPDATE rsa SET running_order = running_order + 1 WHERE rsa_id = ?', [rsa_id]);

        return resp.json({ message: ['POD Booking accepted successfully!'], status: 1, code: 200 });
    } else {
        return resp.json({ message: ['Sorry this is a duplicate entry!'], status: 0, code: 200 });
    }
};
const driverEnroute = async (req, resp) => {
    
    const { booking_id, rsa_id, latitude, longitude } = mergeParam(req);

    const checkOrder = await queryDB(`
        SELECT rider_id, 
            (SELECT fcm_token FROM riders WHERE rider_id = portable_charger_booking_assign.rider_id limit 1) AS fcm_token
        FROM 
            portable_charger_booking_assign
        WHERE 
            order_id = ? AND rsa_id = ? AND status = 1
        LIMIT 1
    `,[booking_id, rsa_id]);

    if (!checkOrder) {
        return resp.json({ message: [`Sorry no booking found with this booking id ${booking_id}`], status: 0, code: 404 });
    }
    const ordHistoryCount = await queryDB(
        'SELECT COUNT(*) as count FROM portable_charger_history WHERE rsa_id = ? AND order_status = "ER" AND booking_id = ?', [rsa_id, booking_id]
    );
    if (ordHistoryCount.count === 0) {
        const insert = await db.execute(
            'INSERT INTO portable_charger_history (booking_id, rider_id, order_status, rsa_id, latitude, longitude) VALUES (?, ?, "ER", ?, ?, ?)',
            [booking_id, checkOrder.rider_id, rsa_id, latitude, longitude]
        );
        if(insert.affectedRows == 0) return resp.json({ message: ['Oops! Something went wrong! Please Try Again'], status: 0, code: 200 });

        await updateRecord('portable_charger_booking', {status: 'ER'}, ['booking_id' ], [booking_id ]);

        const href    = `portable_charger_booking/${booking_id}`;
        const title   = 'PlusX Electric team is on the way!';
        const message = `Please have your EV ready for charging.`;
        await createNotification(title, message, 'Portable Charging', 'Rider', 'RSA', rsa_id, checkOrder.rider_id, href);
        await pushNotification(checkOrder.fcm_token, title, message, 'RDRFCM', href);

        return resp.json({ message : ['Booking Status changed successfully!'], status: 1, code: 200 });
    } else {
        return resp.json({ message : ['Sorry this is a duplicate entry!'], status: 0, code: 200 });
    }
};
const reachedLocation = async (req, resp) => {
    const { booking_id, rsa_id, latitude, longitude } = mergeParam(req);

    const checkOrder = await queryDB(`
        SELECT rider_id, 
            (SELECT fcm_token FROM riders WHERE rider_id = portable_charger_booking_assign.rider_id limit 1) AS fcm_token
        FROM 
            portable_charger_booking_assign
        WHERE 
            order_id = ? AND rsa_id = ? AND status = 1
        LIMIT 1
    `,[booking_id, rsa_id]);

    if (!checkOrder) {
        return resp.json({ message: [`Sorry no booking found with this booking id ${booking_id}`], status: 0, code: 404 });
    }
    const ordHistoryCount = await queryDB(
        'SELECT COUNT(*) as count FROM portable_charger_history WHERE rsa_id = ? AND order_status = "RL" AND booking_id = ?',[rsa_id, booking_id]
    );
    if (ordHistoryCount.count === 0) {
        const insert = await db.execute(
            'INSERT INTO portable_charger_history (booking_id, rider_id, order_status, rsa_id, latitude, longitude) VALUES (?, ?, "RL", ?, ?, ?)',
            [booking_id, checkOrder.rider_id, rsa_id, latitude, longitude]
        );
        if(insert.affectedRows == 0) return resp.json({ message: ['Oops! Something went wrong! Please Try Again'], status: 0, code: 200 });

        await updateRecord('portable_charger_booking', {status: 'RL', rsa_id}, ['booking_id'], [booking_id] );

        const href    = `portable_charger_booking/${booking_id}`;
        const title   = 'POD Reached at Location';
        const message = `The POD has arrived. Please unlock your EV.`;
        await createNotification(title, message, 'Portable Charging', 'Rider', 'RSA', rsa_id, checkOrder.rider_id, href);
        await pushNotification(checkOrder.fcm_token, title, message, 'RDRFCM', href);

        return resp.json({ message: ['POD Reached at Location Successfully!'], status: 1, code: 200 });
    } else {
        return resp.json({ message: ['Sorry this is a duplicate entry!'], status: 0, code: 200 });
    }
};
const chargingStart = async (req, resp) => {
    const { booking_id, rsa_id, latitude, longitude, pod_id='', guideline='', remark='' } = mergeParam(req);
    // if (!req.files || !req.files['image']) return resp.status(405).json({ message: ["Vehicle Image is required"], status: 0, code: 405, error: true });
    
    const checkOrder = await queryDB(`
        SELECT rider_id, 
            (SELECT fcm_token FROM riders WHERE rider_id = portable_charger_booking_assign.rider_id limit 1) AS fcm_token
        FROM 
            portable_charger_booking_assign
        WHERE 
            order_id = ? AND rsa_id = ? AND status = 1
        LIMIT 1
    `,[booking_id, rsa_id]);
    
    const images = ''; //req.files['image'] ? req.files['image'].map(file => file.filename).join('*') : '';

    if (!checkOrder) {
        return resp.json({ message: [`Sorry no booking found with this booking id ${booking_id}`], status: 0, code: 404 });
    }
    const ordHistoryCount = await queryDB(
        'SELECT COUNT(*) as count FROM portable_charger_history WHERE rsa_id = ? AND order_status = "CS" AND booking_id = ?',[rsa_id, booking_id]
    );
    if (ordHistoryCount.count === 0) {
        const podBatteryData = await getPodBatteryData(pod_id);
        const podData        = podBatteryData.data.length > 0 ? JSON.stringify(podBatteryData.data) : null;
        const sumOfLevel     = podBatteryData.sum ?  podBatteryData.sum : '';
        
        // const insert = await db.execute(
        //     'INSERT INTO portable_charger_history (booking_id, rider_id, order_status, rsa_id, latitude, longitude, pod_data) VALUES (?, ?, "CS", ?, ?, ?, ?)',
        //     [booking_id, checkOrder.rider_id, rsa_id, latitude, longitude, podData]
        // );
        const insert = await db.execute(
            'INSERT INTO portable_charger_history (booking_id, rider_id, order_status, rsa_id, latitude, longitude, pod_data, image, guideline, remarks) VALUES (?, ?, "CS", ?, ?, ?, ?, ?, ?, ?)',
            [booking_id, checkOrder.rider_id, rsa_id, latitude, longitude, podData, images, guideline, remark]
        );
        if(insert.affectedRows == 0) return resp.json({ message: ['Oops! Something went wrong! Please Try Again'], status: 0, code: 200 });
        let addressAlert = ( parseInt(guideline) > 0 ) ? remark : '';
        await updateRecord('portable_charger_booking', {status: 'CS', rsa_id, pod_id, start_charging_level: sumOfLevel, address_alert : addressAlert }, ['booking_id'], [booking_id] );
        await updateRecord('pod_devices', { charging_status : 1, latitude, longitude}, ['pod_id'], [pod_id] );

        const href    = `portable_charger_booking/${booking_id}`;
        const title   = 'EV Charging Start';
        const message = `POD has started charging your EV!`;
        await createNotification(title, message, 'Portable Charging', 'Rider', 'RSA', rsa_id, checkOrder.rider_id, href);
        await pushNotification(checkOrder.fcm_token, title, message, 'RDRFCM', href);

        return resp.json({ message: ['Vehicle Charging Start successfully!'], status: 1, code: 200 });
    } else {
        return resp.json({ message: ['Sorry this is a duplicate entry!'], status: 0, code: 200 });
    }
};
const chargingComplete = async (req, resp) => {
    const { booking_id, rsa_id, latitude, longitude, pod_id } = mergeParam(req);
    // 
    const checkOrder = await queryDB(`
        SELECT rider_id, 
            (SELECT fcm_token FROM riders WHERE rider_id = portable_charger_booking_assign.rider_id limit 1) AS fcm_token,
            (SELECT pod_id FROM portable_charger_booking as pcb WHERE pcb.booking_id = portable_charger_booking_assign.order_id limit 1) AS pod_id
        FROM 
            portable_charger_booking_assign
        WHERE 
            order_id = ? AND rsa_id = ? AND status = 1
        LIMIT 1
    `,[booking_id, rsa_id]);

    if (!checkOrder) {
        return resp.json({ message: [`Sorry no booking found with this booking id ${booking_id}`], status: 0, code: 404 });
    }
    const ordHistoryCount = await queryDB(
        'SELECT COUNT(*) as count FROM portable_charger_history WHERE rsa_id = ? AND order_status = "CC" AND booking_id = ?',[rsa_id, booking_id]
    );
    if (ordHistoryCount.count === 0) {

        const podBatteryData = await getPodBatteryData(checkOrder.pod_id);  //POD ID nikalana hoga 
        const podData        = podBatteryData.data ? JSON.stringify(podBatteryData.data) : [];
        const sumOfLevel     = podBatteryData.sum ? podBatteryData.sum : 0;

        const insert = await db.execute(
            'INSERT INTO portable_charger_history (booking_id, rider_id, order_status, rsa_id, latitude, longitude, pod_data) VALUES (?, ?, "CC", ?, ?, ?, ?)',
            [booking_id, checkOrder.rider_id, rsa_id, latitude, longitude, podData]
        );
        if(insert.affectedRows == 0) return resp.json({ message: ['Oops! Something went wrong! Please Try Again'], status: 0, code: 200 });

        await updateRecord('portable_charger_booking', {status: 'CC', rsa_id, end_charging_level:sumOfLevel }, ['booking_id'], [booking_id] );
        await updateRecord('pod_devices', { charging_status : 0 }, ['pod_id'], [checkOrder.pod_id] );

        const href    = `portable_charger_booking/${booking_id}`;
        const title   = 'Charging Completed!';
        const message = `Charging complete, please lock your EV.`;
        await createNotification(title, message, 'Portable Charging', 'Rider', 'RSA', rsa_id, checkOrder.rider_id, href);
        await pushNotification(checkOrder.fcm_token, title, message, 'RDRFCM', href);

        return resp.json({ message: ['Vehicle Charging Completed successfully!'], status: 1, code: 200 });
    } else {
        return resp.json({ message: ['Sorry this is a duplicate entry!'], status: 0, code: 200 });
    }
};
const chargerPickedUp = async (req, resp) => {
    const { booking_id, rsa_id, latitude, longitude, remark='' } = mergeParam(req);
    if (!req.files || !req.files['image']) return resp.status(405).json({ message: ["Vehicle Image is required"], status: 0, code: 405, error: true });
    
    const checkOrder = await queryDB(`
        SELECT rider_id, 
            (SELECT fcm_token FROM riders WHERE rider_id = portable_charger_booking_assign.rider_id limit 1) AS fcm_token,
            (select pod_id from portable_charger_booking as pb where pb.booking_id = portable_charger_booking_assign.order_id limit 1) as pod_id
        FROM 
            portable_charger_booking_assign
        WHERE 
            order_id = ? AND rsa_id = ? AND status = 1
        LIMIT 1
    `,[booking_id, rsa_id]);  //

    const images = req.files['image'] ? req.files['image'].map(file => file.filename).join('*') : '';
    // const [slot, pod_id] = checkOrder.slot_pod.split('/');  //  CONCAT(slot, "/" ,pod_id) 
    
    if (!checkOrder) {
        return resp.json({ message: [`Sorry no booking found with this booking id ${booking_id}`], status: 0, code: 404 });
    }
    const ordHistoryCount = await queryDB(
        'SELECT COUNT(*) as count FROM portable_charger_history WHERE rsa_id = ? AND order_status = "PU" AND booking_id = ?',[rsa_id, booking_id]
    );
    if (ordHistoryCount.count === 0) {
        const insert = await db.execute(
            'INSERT INTO portable_charger_history (booking_id, rider_id, order_status, rsa_id, latitude, longitude, image, remarks) VALUES (?, ?, "PU", ?, ?, ?, ?, ?)',
            [booking_id, checkOrder.rider_id, rsa_id, latitude, longitude, images, remark]
        );
        if(insert.affectedRows == 0) return resp.json({ message: ['Oops! Something went wrong! Please Try Again'], status: 0, code: 200 });

        await updateRecord('portable_charger_booking', {status: 'PU', rsa_id}, ['booking_id'], [booking_id] );
        if(checkOrder.pod_id) {
            await updateRecord('pod_devices', { latitude, longitude}, ['pod_id'], [checkOrder.pod_id] );
        }
        const invoiceId   = booking_id.replace('PCB', 'INVPC');
        const bookingData = await getTotalAmountFromService(booking_id, 'PCB');
        // const totalAmount =(bookingData.total_amount * 100);//total_amount zero aa raha hai usko sahi karna hoga
        // const paymentData = await queryDB(`SELECT amount, invoice_id, payment_intent_id, payment_method_id, payment_cust_id, invoice_date FROM portable_charger_invoice WHERE invoice_id = ?`, [invoiceId]);
        // if(!paymentData) return resp.json({status: 0, code: 422, message: 'invalid paymentd details'});
        
        // const customerId      = paymentData.payment_cust_id;
        // const paymentMethodId = paymentData.payment_method_id;
        // const autoDebit       = await createAutoDebit(customerId, paymentMethodId, totalAmount);

        // if(autoDebit.status == 1) { 
        //     const updates = {
        //         payment_intent_id : autoDebit.paymentIntent.id, 
        //         payment_method_id : autoDebit.paymentIntent.payment_method,
        //         amount            : totalAmount + paymentData.amount
        //     };
        //     await updateRecord('portable_charger_invoice', updates, ['invoice_id'], [invoiceId]);
        
            // const invoice_date =  paymentData.invoice_date ? moment(paymentData.invoice_date).format('MMM D, YYYY') : moment().utcOffset('+04:00').format('MMM D, YYYY') ;
            await updateRecord('portable_charger_invoice', {invoice_status : "S"}, ['invoice_id'], [invoiceId]);
            const data = {
                invoice_id   : invoiceId,
                booking_id   : booking_id,
                rider_name   : bookingData.data.rider_name,
                invoice_date : moment().utcOffset('+04:00').format('MMM D, YYYY'),
                
                kw          : bookingData.data.kw,
                currency    : 'AED',
                kw_dewa_amt : bookingData.data.kw_dewa_amt,
                kw_cpo_amt  : bookingData.data.kw_cpo_amt,
                delv_charge : (bookingData.data.delv_charge - (bookingData.data.kw_dewa_amt + bookingData.data.kw_cpo_amt) ),
                t_vat_amt   : ( bookingData.data.delv_charge * 5) / 100, //bookingData.data.t_vat_amt,
                total_amt   : bookingData.data.delv_charge,
                dis_price   : 0
            };
            if( bookingData.data.discount > 0 ) {
                const dis_price = ( data.total_amt  * bookingData.data.discount ) /100;
                const total_amt  = (data.total_amt - dis_price) ? (data.total_amt - dis_price) : 0;
                
                data.dis_price  = dis_price;
                data.t_vat_amt  = Math.floor(( total_amt ) * 5) / 100;
                data.total_amt  = total_amt + ( Math.floor(( total_amt ) * 5) / 100 );
            } else {
                data.total_amt  = bookingData.data.kw_dewa_amt + bookingData.data.kw_cpo_amt + data.delv_charge + data.t_vat_amt;
            }
            const invoiceData  = { data, numberToWords, formatNumber };
            const templatePath = path.join(__dirname, '../../views/mail/portable-charger-invoice.ejs');
            const filename     = `${invoiceId}-invoice.pdf`;
            const savePdfDir   = 'portable-charger-invoice';
            const pdf          = await generatePdf(templatePath, invoiceData, filename, savePdfDir, req);

            if(!pdf || !pdf.success){
                return resp.json({ message: ['Failed to generate invoice. Please Try Again!'], status: 0, code: 200 });
            }
            if(pdf.success){
                const html = `<html>
                    <body>
                        <h4>Dear ${bookingData.data.rider_name}</h4>
                        <p>We hope you are doing well!</p>
                        <p>Thank you for choosing our Portable EV Charger service for your EV. We are pleased to inform you that your booking has been successfully completed, and the details of your invoice are attached.</p>
                        <p>We appreciate your trust in PlusX Electric and look forward to serving you again.</p>
                        <p> Regards,<br/>PlusX Electric Team </p>
                    </body>
                </html>`;
                const attachment = {
                    filename: `${invoiceId}-invoice.pdf`, path: pdf.pdfPath, contentType: 'application/pdf'
                };
            
                emailQueue.addEmail(bookingData.data.rider_email, 'PlusX Electric: Invoice for Your Portable EV Charger Service', html, attachment);
            }
        // }
        return resp.json({ message: ['Portable Charger picked-up successfully!'], status: 1, code: 200 });
    } else {
        return resp.json({ message: ['Sorry this is a duplicate entry!'], status: 0, code: 200 });
    }
};
const reachedOffice = async (req, resp) => {
    const { booking_id, rsa_id, latitude, longitude } = mergeParam(req);
    
    const checkOrder = await queryDB(`
        SELECT rider_id, 
            (select pod_id from portable_charger_booking as pb where pb.booking_id = portable_charger_booking_assign.order_id limit 1) as pod_id
        FROM 
            portable_charger_booking_assign
        WHERE 
            order_id = ? AND rsa_id = ? AND status = 1
        LIMIT 1
    `,[booking_id, rsa_id]);

    if (!checkOrder) {
        return resp.json({ message: [`Sorry no booking found with this booking id ${booking_id}`], status: 0, code: 404 });
    }
    const ordHistoryCount = await queryDB(
        'SELECT COUNT(*) as count FROM portable_charger_history WHERE rsa_id = ? AND order_status = "RO" AND booking_id = ?', [rsa_id, booking_id]
    );
    // const conn = await startTransaction();
    if (ordHistoryCount.count === 0) {
        const insert = await db.execute(
            'INSERT INTO portable_charger_history (booking_id, rider_id, order_status, rsa_id, latitude, longitude) VALUES (?, ?, "RO", ?, ?, ? )',
            [booking_id, checkOrder.rider_id, rsa_id, latitude, longitude]
        );
        if(insert.affectedRows == 0) return resp.json({ message: ['Oops! Something went wrong! Please Try Again'], status: 0, code: 200 });

        await updateRecord('portable_charger_booking', {status: 'RO', rsa_id}, ['booking_id'], [booking_id] );
        await db.execute(`DELETE FROM portable_charger_booking_assign WHERE rsa_id = ? and order_id = ?`, [rsa_id, booking_id]);

        await portableChargerInvoice(checkOrder.rider_id, booking_id); 
        if(checkOrder.pod_id) {
            await updateRecord('pod_devices', { latitude, longitude}, ['pod_id'], [checkOrder.pod_id] );
        }
        return resp.json({ message: ['POD reached the office successfully!'], status: 1, code: 200 });
    } else {
        return resp.json({ message: ['Sorry this is a duplicate entry!'], status: 0, code: 200 });
    }
};


/* User Cancel Booking */
export const userCancelPCBooking = asyncHandler(async (req, resp) => {
    const { rider_id, booking_id, reason='' } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {rider_id: ["required"], booking_id: ["required"] });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const checkOrder = await queryDB(`
        SELECT 
            rsa_id, address, slot_time, user_name, 
            DATE_FORMAT(slot_date, '%Y-%m-%d') AS slot_date,
            concat( country_code, "-", contact_no) as contact_no, 
            (SELECT rd.rider_email FROM riders AS rd WHERE rd.rider_id = pcb.rider_id) AS rider_email,
            (SELECT rd.rider_name FROM riders AS rd WHERE rd.rider_id = pcb.rider_id) AS rider_name,
            (select fcm_token from riders as r where r.rider_id = pcb.rider_id ) as fcm_token, 
            (select fcm_token from rsa where rsa.rsa_id = pcb.rsa_id ) as rsa_fcm_token
        FROM 
            portable_charger_booking AS pcb
        WHERE 
            booking_id = ? AND rider_id = ? AND status IN ('CNF','A','ER') 
        LIMIT 1
    `,[booking_id, rider_id]);

    if (!checkOrder) {
        return resp.json({ message: [`Sorry no booking found with this booking id ${booking_id}`], status: 0, code: 404 });
    }
    const fSlotDateTime  = moment(`${checkOrder.slot_date} ${checkOrder.slot_time}`);
    const twoHoursBefore = moment(fSlotDateTime).subtract(2, 'hours');
    
    if (moment().isAfter(twoHoursBefore)) {
        return resp.json({
            status  : 0,
            code    : 404,
            message : 'Too late to proceed. You need to make the request at least 2 hours before the slot time.'
        });
    }
    const insert = await db.execute(
        'INSERT INTO portable_charger_history (booking_id, rider_id, order_status, rsa_id, cancel_by, cancel_reason) VALUES (?, ?, "C", ?, "User", ?)',
        [booking_id, rider_id, checkOrder.rsa_id, reason]
    );
    if(insert.affectedRows == 0) return resp.json({ message: ['Oops! Something went wrong! Please Try Again'], status: 0, code: 200 });

    await updateRecord('portable_charger_booking', {status : 'C'}, ['booking_id'], [booking_id]);

    const href    = `portable_charger_booking/${booking_id}`;
    const title   = 'Portable Charger Cancel!';
    const message = `Portable Charger: Booking ID ${booking_id} - ${checkOrder.rider_name} cancelled the booking.`;
    await createNotification(title, message, 'Portable Charging', 'Admin', 'Rider',  rider_id, '', href);

    if(checkOrder.rsa_id) {
        await db.execute(`DELETE FROM portable_charger_booking_assign WHERE order_id=? AND rider_id=?`, [booking_id, rider_id]);
        // await db.execute('UPDATE rsa SET running_order = running_order - 1 WHERE rsa_id = ?', [checkOrder.rsa_id]);
    }

    /* const html = `<html>
        <body>
            <h4>Dear ${checkOrder.user_name},</h4>
            <p>We would like to inform you that your booking for the portable charger has been successfully cancelled. Below are the details of your cancelled booking:</p>
            Booking ID    : ${booking_id}<br>
            Date and Time : ${moment(checkOrder.slot_date, 'YYYY MM DD').format('D MMM, YYYY,')} ${moment(checkOrder.slot_time, 'HH:mm').format('h:mm A')}
            <p>If this cancellation was made in error or if you wish to reschedule, please feel free to reach out to us. We're happy to assist you.</p>
            <p>Thank you for using PlusX Electric. We hope to serve you again soon.</p>
            <p>Best regards,<br/>PlusX Electric Team </p>
        </body>
    </html>`;
    emailQueue.addEmail(checkOrder.rider_email, `PlusX Electric App: Booking Cancellation`, html);

    const adminHtml = `<html>
        <body>
            <h4>Dear Admin,</h4>
            <p>This is to inform you that a user has cancelled their booking for the Portable EV Charging Service. Please see the details below for record-keeping and any necessary follow-up.</p>
            <p>Booking Details:</p>
            User Name    : ${checkOrder.user_name}</br>
            User Contact    : ${checkOrder.contact_no}</br>
            Booking ID    : ${booking_id}</br>
            Scheduled Date and Time : ${checkOrder.slot_date} - ${checkOrder.slot_time}</br> 
            Location      : ${checkOrder.address}</br>
            <p>Thank you for your attention to this update.</p>
            <p>Best regards,<br/>PlusX Electric Team </p>
        </body>
    </html>`;
    emailQueue.addEmail(process.env.MAIL_POD_ADMIN, `Portable Charger Service Booking Cancellation ( :Booking ID : ${booking_id} )`, adminHtml); */

    return resp.json({ message: ['Booking has been cancelled successfully!'], status: 1, code: 200 });
});

/* Save POD Charging History */
export const storePodChargerHistory = asyncHandler(async (req, resp) => {
    const { rsa_id, pod_id, charging_status, latitude, longitude } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {rsa_id: ["required"], pod_id: ["required"], charging_status: ["required"], latitude: ["required"], longitude: ["required"] });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
    if (!['CS', 'CE'].includes(charging_status)) return resp.json({status:0, code:422, message:"Status should be CS or CE"});

    const podBatteryData = await getPodBatteryData(pod_id);
    const podData        = podBatteryData.data.length > 0 ? JSON.stringify(podBatteryData.data) : null;
    const sumOfLevel     = podBatteryData.sum ?  podBatteryData.sum : '';
    const status         = charging_status === 'CS' ? 1 : 2;
    let   isStored       = 0;
    
    if(charging_status === 'CS'){
        const insert = await insertRecord('pod_charge_history', 
            ['pod_id', 'start_charging_level', 'pod_data_start', 'status', 'longitude', 'latitude'],
            [pod_id, sumOfLevel, podData, status, latitude, longitude]
        );
        isStored = insert.affectedRows > 0 ? 1 : 0;
    }
    if(charging_status === 'CE'){
        const update = await updateRecord('pod_charge_history', {end_charging_level: sumOfLevel, pod_data_end: podData, status, latitude, longitude}, ['pod_id'], [pod_id]);
        isStored = update.affectedRows > 0 ? 1 : 0;
    }

    return resp.json({
        status: isStored ? 1 : 0,
        message: isStored ? 'POD charger history saved successfully' : 'Failed to store, Please Try Again.'
    });

});

const getPodBatteryData = async (pod_id) => {
    try {
        // const { pod_id, } = req.body;
        // const { isValid, errors } = validateFields(req.body, {
        //     pod_id : ["required"]
        // });
        // if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

        const [chargerDetails] = await db.execute(`
            SELECT 
                battery_id, capacity, rssi, cells, temp1, temp2, temp3, current, voltage, percentage, charge_cycle, latitude, longitude, cells 
            FROM 
                pod_device_battery 
            WHERE 
                pod_id = ?`, 
            [pod_id]
        );
        const sum = chargerDetails.map( obj  => (obj.percentage || 0).toFixed(2) ) ;
        const returnObj = {
            sum  : sum.join(','),
            data : chargerDetails,
        };
        return returnObj;
    } catch (error) {
    
        const returnObj = {
            sum  : '',
            data : [],
        };
        return returnObj ;
    }

}
// ye new bana hai 
const portableChargerInvoice = async (rider_id, request_id ) => {
    try {
        const checkOrder = await queryDB(` SELECT payment_intent_id
            FROM 
                portable_charger_booking 
            WHERE 
                booking_id = ? AND rider_id = ?
            LIMIT 1
        `,[request_id, rsa_id]);

        if (!checkOrder) {
            return { status : 0  };
        }
        const payment_intent_id = checkOrder.payment_intent_id;
        const invoiceId         = request_id.replace('PCB', 'INVPC');
        const createObj = {
            invoice_id     : invoiceId,
            request_id     : request_id,
            rider_id       : rider_id,
            invoice_date   : moment().format('YYYY-MM-DD HH:mm:ss'),
            payment_status : 'Approved'
        }
        if(payment_intent_id && payment_intent_id.trim() != '' ){
            const paymentIntent = await stripe.paymentIntents.retrieve(payment_intent_id);
            // console.log(paymentIntent)
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
            createObj.transaction_id    = charge.payment_method_details.card.three_d_secure?.transaction_id || null;  
            createObj.payment_type      = charge.payment_method_details.type;  
            createObj.currency          = charge.currency;  
            createObj.invoice_date      = moment.unix(charge.created).format('YYYY-MM-DD HH:mm:ss');
            createObj.receipt_url       = charge.receipt_url;
            createObj.card_data         = cardData;
        }
        // return resp.json(createObj);
        const columns = Object.keys(createObj);
        const values  = Object.values(createObj);
        const insert  = await insertRecord('portable_charger_invoice', columns, values);
        
        return { status: (insert.affectedRows > 0) ? 1 : 0 };
        
    } catch (error) {

        return { status:0  };
    }
};

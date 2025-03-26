import db, { startTransaction, commitTransaction, rollbackTransaction } from "../../config/db.js";
import { getPaginatedData, insertRecord, queryDB, updateRecord } from '../../dbUtils.js';
import validateFields from "../../validation.js";
import { createNotification, pushNotification,asyncHandler, formatDateTimeInQuery, formatDateInQuery } from '../../utils.js';
import moment from 'moment';

/* RA Booking */
export const bookingList = asyncHandler(async (req, resp) => {
    const { start_date, end_date, search_text = '', status, page_no } = req.body;

    const whereFields = []
    const whereValues = []
    const whereOperators = []

    if (start_date && end_date) {
        const start = moment(start_date, "YYYY-MM-DD").startOf('day').format("YYYY-MM-DD HH:mm:ss");
        const end   = moment(end_date, "YYYY-MM-DD").endOf('day').format("YYYY-MM-DD HH:mm:ss");

        whereFields.push('created_at', 'created_at');
        whereValues.push(start, end);
        whereOperators.push('>=', '<=');
    }

    if(status) {
        whereFields.push('order_status');
        whereValues.push(status);
        whereOperators.push('=');
    }

    const result = await getPaginatedData({
        tableName: 'road_assistance',
        columns: `request_id, rider_id, rsa_id, name, country_code, contact_no, price, order_status, ${formatDateTimeInQuery(['created_at'])}`,
        liveSearchFields: ['request_id', 'name'],
        liveSearchTexts: [search_text, search_text],
        sortColumn: 'id',
        sortOrder: 'DESC',
        page_no,
        limit: 10,
        whereField: whereFields,
        whereValue: whereValues,
        whereOperator: whereOperators
    });

    return resp.json({
        status: 1,
        code: 200,
        message: ["Booking List fetch successfully!"],
        data: result.data,
        total_page: result.totalPage,
        total: result.total,
    });    
});

export const bookingData = asyncHandler(async (req, resp) => {
    const { request_id } = req.body;
    const booking = await queryDB(`SELECT *, ${formatDateTimeInQuery(['created_at', 'updated_at'])} FROM road_assistance WHERE request_id = ?`, [request_id]);

    const result = {
        // status: 1,
    }

    if(request_id){
        result.booking = booking;
    }

    // return resp.status(200).json(result);
    return resp.json({
        status  : 1,
        code    : 200,
        message : ["Booking details fetched successfully!"],
        result
    });
});

export const evRoadAssistanceConfirmBooking = asyncHandler(async (req, resp) => {
    const { request_id, latitude, longitude } = req.body;

    const order = await queryDB(`
        SELECT 
            rider_id, pickup_latitude, pickup_longitude,
            (select fcm_token from riders as r where r.rider_id = road_assistance.rider_id ) as fcm_token
        FROM road_assistance
        WHERE request_id = ? AND order_status = ?
        LIMIT 1  
    `, [request_id, 'BD']);

    if(!order) return resp.json({status:0, message: "No booking found on this booking id."});

    const rsa = await queryDB(`
        SELECT 
            fcm_token, rsa_id,
            (6367 * ACOS(COS(RADIANS(?)) * COS(RADIANS(latitude)) * COS(RADIANS(longitude) - RADIANS(?)) + SIN(RADIANS(?)) * SIN(RADIANS(latitude)))) AS distance
        FROM rsa
        WHERE status = ? AND booking_type = ?
        LIMIT 1  
    `, [latitude, longitude, latitude, 2, 'Roadside Assistance']);

    if(rsa){
        await insertRecord('order_assign', ['order_id', 'rsa_id', 'rider_id', 'status'], [request_id, rsa.rsa_id, order.rider_id, 0]);
        await insertRecord('order_history', ['order_id', 'rsa_id', 'rider_id', 'order_status'], [request_id, rsa.rsa_id, order.rider_id, 'CNF']);
        await db.execute(`UPDATE road_assistance SET order_status = 'CNF' WHERE request_id = ?`, [request_id]);

        const title = 'Request Assigned';
        const message = `An roadside assistance request has been assigned to you with request id : ${request_id}`;
        const href = `road_assistance/${request_id}`;
        createNotification(title, message, 'Roadside Assistance', 'RSA', 'Admin', '', rsa.rsa_id, href);
        pushNotification(rsa.fcm_token, title, message, 'RSAFCM', href);

        return resp.json({status: 1, message: "You have successfully Assigned roadside assistance request."});
    }else{
        await db.execute(`UPDATE road_assistance SET order_status = 'CNF' WHERE request_id = ?`, [request_id]);
        return resp.json({status: 1, message: "You have successfully Confirm roadside assistance request."});
    }
});

export const evRoadAssistanceCancelBooking = asyncHandler(async (req, resp) => {
    const { request_id, reason } = req.body;
    const { isValid, errors } = validateFields(req.body, { request_id : ["required"], reason : ["required"] });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const order = await queryDB(`
        SELECT 
            rider_id, (select fcm_token from riders as r where r.rider_id = road_assistance.rider_id ) as fcm_token
        FROM road_assistance
        WHERE request_id = ? AND order_status = ?
        LIMIT 1  
    `, [request_id, 'BD']);

    if(!order) return resp.json({status:0, message: "No booking found on this booking id."});

    await db.execute(`UPDATE road_assistance SET order_status = 'C' WHERE request_id = ?`, [request_id]);
    await insertRecord('order_history', ['order_id', 'rider_id', 'cancel_by', 'order_status', 'cancel_reason'], [request_id, order.rider_id, 'Admin', 'CNF', reason]);

    const title = 'Order Cancelled!';
    const message = `We regret to inform you that your roadside assistance order no : ${request_id} has been cancelled.`;
    const href = `road_assistance/${request_id}`;
    createNotification(title, message, 'Roadside Assistance', 'Rider', 'Admin', '', order.rider_id, href);
    pushNotification(order.fcm_token, title, message, 'RDRFCM', href);

    return resp.json({status: 1, code:200, message: "Booking has been cancelled successfully!."});
});


/* RA Invoie */
export const invoiceList = asyncHandler(async (req, resp) => {
    const { page_no, search_text,start_date, end_date } = req.body;

    const whereFields = []
    const whereValues = []
    const whereOperators = []

    if (start_date && end_date) {
        const start = moment(start_date, "YYYY-MM-DD").startOf('day').format("YYYY-MM-DD HH:mm:ss");
        const end = moment(end_date, "YYYY-MM-DD").endOf('day').format("YYYY-MM-DD HH:mm:ss");

        whereFields.push('created_at', 'created_at');
        whereValues.push(start, end);
        whereOperators.push('>=', '<=');
    }

    const result = await getPaginatedData({
        tableName: 'road_assistance_invoice',
        columns: `invoice_id, request_id, rider_id, amount, transaction_id, payment_type,payment_status, ${formatDateInQuery(['invoice_date'])}, receipt_url, ${formatDateTimeInQuery(['created_at'])}, 
                (select concat(name, ",", country_code, "-", contact_no) from road_assistance as cs where cs.request_id = road_assistance_invoice.request_id limit 1)
                AS riderDetails`,
        searchFields: [],
        searchTexts: [],
        sortColumn: 'id',
        sortOrder: 'DESC',
        page_no,
        limit: 10,
        liveSearchFields: ['invoice_id'],
        liveSearchTexts: [search_text],
        whereField: whereFields,
        whereValue: whereValues,
        whereOperator: whereOperators
    });

    return resp.json({
        status: 1,
        code: 200,
        message: ["Invoice List fetch successfully!"],
        data: result.data,
        total_page: result.totalPage,
        total: result.total,
    });    
});

export const invoiceData = asyncHandler(async (req, resp) => {
    const { invoice_id } = req.body;
    const invoice = await queryDB(`
        SELECT rai.*, ra.name, ra.country_code, ra.contact_no
        FROM road_assistance_invoice AS rai
        JOIN road_assistance AS ra ON rai.request_id = ra.request_id
        WHERE rai.invoice_id = ?
    `, [invoice_id]);

    const result = {
        status: 1,
        code: 200,
        invoice
    };

    return resp.status(200).json(result);
});



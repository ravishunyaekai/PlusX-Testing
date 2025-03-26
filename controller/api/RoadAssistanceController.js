import multer from 'multer';
import moment from "moment";
import dotenv from 'dotenv';
import emailQueue from "../../emailQueue.js";
import validateFields from "../../validation.js";
import { insertRecord, queryDB, getPaginatedData } from '../../dbUtils.js';
import db, { commitTransaction, rollbackTransaction, startTransaction } from "../../config/db.js";
import { asyncHandler, createNotification, formatDateTimeInQuery, mergeParam, pushNotification } from '../../utils.js';
dotenv.config();

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const destinationPath = path.join(__dirname, 'public', 'uploads', 'order_file');
        cb(null, destinationPath);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const filename = `${uniqueSuffix}-${file.originalname}`;
        cb(null, filename);
    }
});

export const upload = multer({ storage: storage });

export const addRoadAssistance = asyncHandler(async (req, resp) => {
    const {
        rider_id, name, country_code, contact_no, types_of_issue, pickup_address, drop_address, price, pickup_latitude, pickup_longitude, drop_latitude, drop_longitude, order_status=''
    } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {
        rider_id: ["required"], name: ["required"], country_code: ["required"], contact_no: ["required"], types_of_issue: ["required"], pickup_address: ["required"], 
        drop_address: ["required"], price: ["required"], pickup_latitude: ["required"], pickup_longitude: ["required"], drop_latitude: ["required"], drop_longitude: ["required"]
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const conn = await startTransaction();
    try{
        const rider = await queryDB(`SELECT fcm_token, rider_name, rider_email, (SELECT MAX(id) FROM road_assistance) AS last_index FROM riders WHERE rider_id = ? LIMIT 1`, [rider_id]);

        const start = (!rider.last_index) ? 0 : rider.last_index; 
        const nextId = start + 1;
        const requestId = 'RAO' + String(nextId).padStart(4, '0');

        const insert = await insertRecord('road_assistance', [
            'request_id', 'rider_id', 'name', 'country_code', 'contact_no', 'types_of_issue', 'pickup_address', 'drop_address', 'price', 'order_status', 'pickup_latitude', 'pickup_longitude', 'drop_latitude', 'drop_longitude'
        ], [
            requestId, rider_id, name, country_code, contact_no, types_of_issue, pickup_address, drop_address, price, order_status, pickup_latitude, pickup_longitude, drop_latitude, drop_longitude
        ], conn);

        if(insert.affectedRows === 0) return resp.json({status:0, code:200, message: ['Oops! There is something went wrong! Please Try Again.']});

        await insertRecord('order_history', ['order_id', 'order_status', 'rider_id'], [requestId, 'BD', rider_id], conn);
        
        const href = 'road_assistance/' + requestId;
        const heading = 'Roadside Assistance Created';
        const desc = `One Roadside Assistance request has been placed by you with request id: ${requestId} It is also requested that you must reach on the location.`;
        createNotification(heading, desc, 'Roadside Assistance', 'Rider', 'Admin','', rider_id, href);
        pushNotification(rider.fcm_token, heading, desc, 'RDRFCM', href);

        const now = new Date();
        const formattedDateTime = now.toISOString().replace('T', ' ').substring(0, 19);

        const htmlUser = `<html>
            <body>
                <h4>Dear ${rider.rider_name},</h4>
                <p>Thank you for using the PlusX Electric App for your roadside assistance needs. We have successfully received your booking request. Below are the details of your roadside assistance booking:</p> 
                <p>Booking Reference: ${requestId}</p>
                <p>Date & Time of Request: ${formattedDateTime}</p> 
                <p>Location: ${pickup_address}</p>                         
                <p>Type of Assistance Required: ${types_of_issue}</p> 
            
                <p> Regards,<br/> PlusX Electric App </p>
            </body>
        </html>`;
        const htmlAdmin = `<html>
            <body>
                <h4>Dear Admin,</h4>
                <p>We have received a new booking for our Road Side Assistance. Below are the details:</p> 
                <p>Customer Name  : ${rider.rider_name}</p>
                <p>Pickup Address : ${pickup_address}</p>
                <p>Drop Address   : ${drop_address}</p> 
                <p>Booking Time   : ${formattedDateTime}</p>                         
                <p> Best regards,<br/> PlusX Electric App </p>
            </body>
        </html>`;
        
        emailQueue.addEmail(rider.rider_email, 'Your Roadside Assistance Booking Confirmation - PlusX Electric App', htmlUser);
        emailQueue.addEmail(process.env.MAIL_ADMIN, `Roadside Assistance Booking Confirmation - PlusX Electric App`, htmlAdmin);

        await commitTransaction(conn);
        
        return resp.json({
            status: 1, 
            code: 200, 
            message: ['You have successfully placed roadside assistance request. You will be notified soon'],
            request_id: requestId,
            rsa_id: ''
        });   
    }catch(err){
        await rollbackTransaction(conn);
        console.error("Transaction failed:", err);
        return resp.status(500).json({status: 0, code: 500, message: "Oops! There is something went wrong! Please Try Again" });
    }finally{
        if (conn) conn.release();
    }    
});

export const roadAssistanceList = asyncHandler(async (req, resp) => {
    const {rider_id, page_no, sort_by } = mergeParam(req);
        
    const { isValid, errors } = validateFields(mergeParam(req), {rider_id: ["required"], page_no: ["required"]});
    
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const sortOrder = sort_by === 'd' ? 'DESC' : 'ASC';

    const result = await getPaginatedData({
        tableName: 'road_assistance',
        columns: `request_id, name, country_code, contact_no, types_of_issue, pickup_address, drop_address, price, order_status, ${formatDateTimeInQuery(['created_at'])}`,
        sortColumn: 'id',
        sortOrder,
        page_no,
        limit: 10,
    });

    return resp.json({
        status: 1,
        code: 200,
        message: ["Road Assistance List fetch successfully!"],
        data: result.data,
        total_page: result.totalPage,
        total: result.total,
    });

});

export const roadAssistanceDetail = asyncHandler(async (req, resp) => {
    const { rider_id, order_id } = mergeParam(req);
        
    const { isValid, errors } = validateFields(mergeParam(req), {rider_id: ["required"], order_id: ["required"]});
    
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const [roadAssistance] = await db.execute(`SELECT request_id, name, country_code, contact_no, types_of_issue, pickup_address, drop_address, price, order_status, 
            ${formatDateTimeInQuery(['created_at'])}
        FROM road_assistance WHERE rider_id = ? AND request_id = ? LIMIT 1
    `, [rider_id, order_id]);

    
    const [history] = await db.execute(`SELECT order_status, cancel_by, cancel_reason as reason, rsa_id, 
            ${formatDateTimeInQuery(['created_at'])}, 
            (select rsa.rsa_name from rsa where rsa.rsa_id = order_history.rsa_id) as rsa_name
        FROM order_history 
        WHERE order_id = ?
        ORDER BY id DESC
    `,[order_id]);

    if(roadAssistance.length > 0){
        roadAssistance[0].invoice_url = '';
        if (roadAssistance[0].order_status == 'VD') {
            const invoice_id = roadAssistance[0].request_id.replace('RAO', 'INVR');
            roadAssistance[0].invoice_url = `${req.protocol}://${req.get('host')}/public/road-side-invoice/${invoice_id}-invoice.pdf`;
        }
    }

    return resp.json({
        message: ["Road Assistance Details fetched successfully!"],
        order_data: roadAssistance[0],
        order_history: history,
        status: 1,
        code: 200,
    });
});

/* Invoice */
export const roadAssistanceInvoiceList = asyncHandler(async (req, resp) => {
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
        tableName: 'road_assistance_invoice',
        columns: `invoice_id, amount, payment_status, invoice_date, currency,
            (select concat(name, ",", country_code, "-", contact_no) from road_assistance as rs where rs.rider_id = road_assistance_invoice.rider_id limit 1) AS riderDetails,
            (select types_of_issue from road_assistance as rs where rs.rider_id = road_assistance_invoice.rider_id limit 1) as types_of_issue
        `,
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
        message: ["Road Assistance Invoice List fetch successfully!"],
        data: result.data,
        total_page: result.totalPage,
        total: result.total,
        base_url: `${req.protocol}://${req.get('host')}/uploads/road-side-invoice/`,
    });

});

export const roadAssistanceInvoiceDetail = asyncHandler(async (req, resp) => {
    const {rider_id, invoice_id } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {rider_id: ["required"], invoice_id: ["required"]});
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const invoice = await queryDB(`SELECT 
        rsi.invoice_id, rsi.amount as price, rsi.payment_status, rsi.invoice_date, rsi.currency, rsi.payment_type, r.name, r.country_code, r.contact_no, r.types_of_issue, 
        r.pickup_address, r.drop_address, r.price, r.request_id
        FROM 
            road_assistance_invoice AS rsi
        LEFT JOIN
            road_assistance AS r ON r.request_id = rsi.request_id
        WHERE 
            rsi.invoice_id = ?
    `, [invoice_id]);

    invoice.invoice_url = `${req.protocol}://${req.get('host')}/public/road-side-invoice/${invoice_id}-invoice.pdf`;

    return resp.json({
        message: ["Road Assistance Invoice Details fetch successfully!"],
        data: invoice,
        status: 1,
        code: 200,
    });
});

/* RSA */
export const getRsaOrderStage = asyncHandler(async (req, resp) => {
    const {rsa_id, order_id } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {rsa_id: ["required"], order_id: ["required"]});
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    try{
        const orderStatus = ['A','ER','AR','WC','ES'];
        const orderData = ['assigned_data', 'enroute_data', 'arrived_data', 'work_complete_data', 'end_summary_data'];

        const [stData] = await db.execute(`SELECT order_status, cancel_reason AS reason FROM order_history WHERE order_id = ? AND rsa_id = ? AND order_status != 'RA'`, [order_id, rsa_id]);
        if(stData.length === 0) return resp.json({status:0, code:200, message: "Sorry no data found with given order id: " + order_id});

        const [stTime] = await db.execute(`SELECT created_at FROM order_history WHERE order_id = ? AND rsa_id = ? ORDER BY id DESC LIMIT 1`,[order_id, rsa_id]);
        const stDatas = stData.map(item => item.order_status);
        const [order] = await db.execute(`SELECT order_status, created_at FROM road_assistance WHERE request_id = ?`, [order_id]);
        const stReason = stData.map(item => item.reason).filter(Boolean);

        const orderTracking = [];

        for (const value of orderStatus) {
            const [data] = await db.execute(`SELECT remarks, order_status, image FROM order_history WHERE order_id = ? AND rsa_id = ? AND order_status = ?`, 
                [order_id, rsa_id, value]
            );

            if (data.length > 0) {
                const record = data[0];
                if ((value === 'AR' || value === 'WC') && record.image) {
                    const images = record.image.split(',').map(image => {
                        return `${req.protocol}://${req.get('host')}/uploads/order_file/${image.trim()}`;
                    });
                    record.image = images;
                } else {
                    record.image = null;
                }

                orderTracking.push({ [orderData[orderStatus.indexOf(value)]]: record });
            } else {
                orderTracking.push({ [orderData[orderStatus.indexOf(value)]]: { remarks: null, image: null } });
            }
        }

        let executionTime = null; let humanReadableTime = null;
        if (stTime.length > 0 && order.length > 0) {
            executionTime = moment(stTime[0].created_at).diff(moment(order[0].created_at), 'seconds');
            humanReadableTime = moment.duration(executionTime, 'seconds').humanize();
        } else {
            humanReadableTime = 'Execution time not available';
        }

        return resp.json({
            message: ["Request stage fetch successfully."],
            data: orderTracking,
            order_status: order[0].order_status,
            order_status_list: stDatas,
            execution_time: executionTime,
            reason: stReason.length > 0 ? stReason[0] : '',
            status: 1,
            code: 200
        });
    }catch(err){
        return resp.json({message: ['An error occurred while processing your request.'], status: 0, code: 500});  
    }
});

export const orderAction = asyncHandler(async (req, resp) => {
    const {order_status, order_id } = mergeParam(req);
    const { isValid, errors } = validateFields(mergeParam(req), {order_status: ["required"], order_id: ["required"]});
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    switch (order_status) {
        case 'A': return await acceptOrder(req, resp);
        case 'AR': return await arrivedOrder(req, resp);
        case 'WC': return await workComplete(req, resp);
        case 'ES': return await esOrder(req, resp);
        default: return resp.json({status: 0, code: 200, message: ['Invalid booking status.']});
    }
});

// rs booking/order action helper
const acceptOrder = async (req, resp) => {
    const { order_id, rsa_id, latitude, longitude } = req.body;
    const { isValid, errors } = validateFields(req.body, {rsa_id: ["required"], order_id: ["required"], latitude: ["required"], longitude: ["required"]});
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const checkOrder = await queryDB(`
        SELECT rider_id, 
            (SELECT fcm_token FROM riders WHERE rider_id = charging_service_assign.rider_id) AS fcm_token
        FROM 
            order_assign
        WHERE 
            order_id = ? AND rsa_id = ? AND status = 0
        LIMIT 1
    `,[order_id, rsa_id]);

    if (!checkOrder) {
        return resp.json({ message: [`Sorry no order found with this order id ${order_id}`], status: 0, code: 404 });
    }

    const ordHistoryCount = await queryDB(
        `SELECT COUNT(*) as count FROM order_history WHERE rsa_id = ? AND order_status = "RA" AND order_id = ?`,[rsa_id, order_id]
    );

    if (ordHistoryCount.count === 0) {
        await updateRecord('road_assistance', {order_status: 'RA', rsa_id}, 'request_id', order_id);

        const href = `road_assistance/${order_id}`;
        const title = 'Request Accepted';
        const message = `RSA Team has accepted your booking with booking id : ${order_id} and he is enroute now`;
        await createNotification(title, message, 'Roadside Assistance', 'Rider', 'RSA', rsa_id, checkOrder.rider_id, href);
        await pushNotification(checkOrder.fcm_token, title, message, 'RDRFCM', href);

        const insert = await db.execute(
            `INSERT INTO order_history (order_id, rider_id, order_status, rsa_id, latitude, longitude) VALUES (?, ?, "RA", ?, ?, ?)`,
            [order_id, checkOrder.rider_id, rsa_id, latitude, longitude]
        );

        if(insert.affectedRows == 0) return resp.json({ message: ['Oops! Something went wrong! Please Try Again'], status: 0, code: 200 });

        await db.execute('UPDATE rsa SET running_order = 1 WHERE rsa_id = ?', [rsa_id]);
        await db.execute('UPDATE order_assign SET status = 1 WHERE order_id = ? AND rsa_id = ?', [order_id, rsa_id]);

        return resp.json({ message: ['Request accepted successfully!'], status: 1, code: 200 });
    } else {
        return resp.json({ message: ['Sorry this is a duplicate entry!'], status: 0, code: 200 });
    }
};

const arrivedOrder = async (req, resp) => {
    const { order_id, rsa_id, lat, long, remarks } = req.body;
    const { isValid, errors } = validateFields(req.body, {rsa_id: ["required"], order_id: ["required"], lat: ["required"], long: ["required"]});
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const checkOrder = await queryDB(`
        SELECT rider_id, 
            (SELECT fcm_token FROM riders WHERE rider_id = charging_service_assign.rider_id) AS fcm_token
        FROM 
            order_assign
        WHERE 
            order_id = ? AND rsa_id = ?
        LIMIT 1
    `,[order_id, rsa_id]);

    if (!checkOrder) {
        return resp.json({ message: [`Sorry no order found with this order id ${order_id}`], status: 0, code: 404 });
    }

    const ordHistoryCount = await queryDB(
        `SELECT COUNT(*) as count FROM order_history WHERE rsa_id = ? AND order_status = "AR" AND order_id = ?`,[rsa_id, order_id]
    );

    if (ordHistoryCount.count === 0) {
        /* upload file */
        const image = (uploadedFiles != null) ? uploadedFiles.join(',') : '';
        const insert = await db.execute(
            `INSERT INTO order_history (order_id, rider_id, order_status, rsa_id, remarks, latitude, longitude, image) VALUES (?, ?, "AR", ?, ?, ?, ?, ?)`,
            [order_id, checkOrder.rider_id, rsa_id, remarks, lat, long, image]
        );

        if(insert.affectedRows == 0) return resp.json({ message: ['Oops! Something went wrong! Please Try Again'], status: 0, code: 200 });

        await updateRecord('road_assistance', {order_status: 'AR', rsa_id}, 'request_id', order_id);

        const href = `road_assistance/${order_id}`;
        const title = 'RSA Team Accepted';
        const message = `RSA Team is arrived at your location`;
        await createNotification(title, message, 'Roadside Assistance', 'Rider', 'RSA', rsa_id, checkOrder.rider_id, href);
        await pushNotification(checkOrder.fcm_token, title, message, 'RDRFCM', href);

        return resp.json({ message: ['Arrived successfully!'], status: 1, code: 200 });
    } else {
        return resp.json({ message: ['Sorry this is a duplicate entry!'], status: 0, code: 200 });
    }
};

const workComplete = async (req, resp) => {
    const { order_id, rsa_id, remarks } = req.body;
    const { isValid, errors } = validateFields(req.body, {order_id: ["required"], rsa_id: ["required"], remarks: ["required"]});
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const checkOrder = await queryDB(`
        SELECT rider_id, 
            (SELECT fcm_token FROM riders WHERE rider_id = charging_service_assign.rider_id) AS fcm_token
        FROM 
            charging_service_assign
        WHERE 
            order_id = ? AND rsa_id = ?
        LIMIT 1
    `,[rsa_id, order_id, rsa_id]);

    if (!checkOrder) {
        return resp.json({ message: [`Sorry no order found with this order id ${order_id}`], status: 0, code: 404 });
    }

    const ordHistoryCount = await queryDB(
        'SELECT COUNT(*) as count FROM order_history WHERE rsa_id = ? AND order_status = "WC" AND service_id = ?',[rsa_id, order_id]
    );

    if (ordHistoryCount.count === 0) {
        /* handle file upload */
        const insert = await db.execute(
            'INSERT INTO order_history (order_id, rider_id, order_status, remarks, rsa_id, image) VALUES (?, ?, "WC", ?, ?, ?)',
            [order_id, checkOrder.rider_id, remarks, rsa_id, '']
        );

        if(insert.affectedRows == 0) return resp.json({ message: ['Oops! Something went wrong! Please Try Again'], status: 0, code: 200 });

        await updateRecord('road_assistance', {order_status: 'WC', rsa_id}, 'request_id', order_id);

        const href = `road_assistance/${order_id}`;
        const title = 'Work Completed';
        const message = `RSA Team has successfully completed the work which was required to do with your order id: ${order_id}`;
        await createNotification(title, message, 'Roadside Assistance', 'Rider', 'RSA', rsa_id, checkOrder.rider_id, href);
        await pushNotification(checkOrder.fcm_token, title, message, 'RDRFCM', href);

        return resp.json({ message: ['Work completed! successfully!'], status: 1, code: 200 });
    } else {
        return resp.json({ message: ['Sorry this is a duplicate entry!'], status: 0, code: 200 });
    }
};

const esOrder = async (req, resp) => {
    const { order_id, rsa_id } = req.body;
    const { isValid, errors } = validateFields(req.body, {rsa_id: ["required"], order_id: ["required"]});
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const checkOrder = await queryDB(`
        SELECT rider_id, 
            (SELECT fcm_token FROM riders WHERE rider_id = charging_service_assign.rider_id) AS fcm_token
        FROM 
            order_assign
        WHERE 
            order_id = ? AND rsa_id = ? AND status = 0
        LIMIT 1
    `,[order_id, rsa_id]);

    if (!checkOrder) {
        return resp.json({ message: [`Sorry no order found with this order id ${order_id}`], status: 0, code: 404 });
    }

    const ordHistoryCount = await queryDB(
        `SELECT COUNT(*) as count FROM order_history WHERE rsa_id = ? AND order_status = "ES" AND order_id = ?`,[rsa_id, order_id]
    );

    if (ordHistoryCount.count === 0) {
        const insert = await db.execute(
            `INSERT INTO order_history (order_id, rider_id, order_status, rsa_id) VALUES (?, ?, "ES", ?)`,
            [order_id, checkOrder.rider_id, rsa_ide]
        );

        if(insert.affectedRows == 0) return resp.json({ message: ['Oops! Something went wrong! Please Try Again'], status: 0, code: 200 });

        await updateRecord('road_assistance', {order_status: 'ES', rsa_id}, 'request_id', order_id);
        await db.execute('DELETE FROM order_assign WHERE order_id = ? AND rsa_id = ?', [order_id, rsa_id]);
        await db.execute('UPDATE rsa SET running_order = 0 WHERE rsa_id = ?', [rsa_id]);

        const href = `road_assistance/${order_id}`;
        const title = 'Request Completed';
        const message = `RSA Team has successfully finished/completed your order with order id : ${order_id}`;
        await createNotification(title, message, 'Roadside Assistance', 'Rider', 'RSA', rsa_id, checkOrder.rider_id, href);
        await pushNotification(checkOrder.fcm_token, 'Order Completed', message, 'RDRFCM', href);

        return resp.json({ message: ['Order completed successfully!'], status: 1, code: 200 });
    } else {
        return resp.json({ message: ['Sorry this is a duplicate entry!'], status: 0, code: 200 });
    }
};
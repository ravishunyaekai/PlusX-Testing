import db, { startTransaction, commitTransaction, rollbackTransaction } from '../../config/db.js';
import dotenv from 'dotenv';
import moment from 'moment';
import { mergeParam, asyncHandler, convertTo24HourFormat, formatDateInQuery, createNotification, pushNotification, deleteFile, formatDateTimeInQuery} from '../../utils.js';
import { queryDB, getPaginatedData, insertRecord, updateRecord } from '../../dbUtils.js';
import validateFields from "../../validation.js";
import generateUniqueId from 'generate-unique-id';
import emailQueue from '../../emailQueue.js';
dotenv.config();



export const chargerList = async (req, resp) => {
    try {
        const {rider_id, page_no, search_text = '' } = req.body;
    const { isValid, errors } = validateFields(req.body, {page_no: ["required"]});
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const result = await getPaginatedData({
        tableName: 'portable_charger',
        columns: 'charger_id, charger_name, charger_price, charger_feature, image, charger_type, status',
        sortColumn: 'created_at',
        sortOrder: 'DESC',
        page_no,
        limit: 10,
        liveSearchFields: ['charger_id', 'charger_name'],
        liveSearchTexts: [search_text, search_text],
        whereField: 'status',
        whereValue: 1
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
        base_url: `${req.protocol}://${req.get('host')}/uploads/offer/`,
    });
    } catch (error) {
        console.error('Error fetching charger list:', error);
        resp.status(500).json({ message: 'Error fetching charger lists' });
    }
};

export const chargerDetails = async (req, resp) => {
    try {
        const { charger_id, } = req.body;

        const { isValid, errors } = validateFields(req.body, {
            charger_id: ["required"]
        });

        if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

        const [chargerDetails] = await db.execute(`
            SELECT 
                charger_id, charger_name, charger_price, charger_feature, image, charger_type, status
            FROM 
                portable_charger 
            WHERE 
                charger_id = ?`, 
            [charger_id]
        );

        return resp.json({
            status: 1,
            code: 200,
            message: ["Portable Charger Details fetched successfully!"],
            data: chargerDetails[0],
            
        });
    } catch (error) {
        console.error('Error fetching charger details:', error);
        return resp.status(500).json({ status: 0, message: 'Error fetching charger details' });
    }
};

export const addCharger = async (req, resp) => {
    try {
        const { charger_name, charger_price, charger_feature, charger_type, status = 1 } = req.body;
        const charger_image = req.files && req.files['charger_image'] ? req.files['charger_image'][0].filename : null;

        // Validation
        const { isValid, errors } = validateFields({ 
            charger_name, charger_price, charger_feature, charger_image, charger_type
        }, {
            charger_name: ["required"],
            charger_price: ["required"],
            charger_feature: ["required"],
            charger_image: ["required"], 
            charger_type: ["required"]
        });

        if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
    
        const last = await queryDB(`SELECT id FROM portable_charger ORDER BY id DESC LIMIT 1`);
        const start = last ? last.id : 0;
        const nextId = start + 1;
        const chargerId = 'PCGR' + String(nextId).padStart(4, '0');
        // console.log(req.body, status, chargerId, charger_image);
    
        const insert = await insertRecord('portable_charger', [
            'charger_id', 'charger_name', 'charger_price', 'charger_feature', 'image', 'charger_type', 'status'
        ],[
            chargerId, charger_name, charger_price, charger_feature, charger_image, charger_type, status
        ]);
    
        return resp.json({
            code: 200,
            message: insert.affectedRows > 0 ? ['Charger added successfully!'] : ['Oops! Something went wrong. Please try again.'],
            status: insert.affectedRows > 0 ? 1 : 0
        });
    } catch (error) {
        console.error('Something went wrong:', error);
        resp.status(500).json({ message: 'Something went wrong' });
    }
};

export const editCharger = async (req, resp) => {
    try {
        const { charger_id, charger_name, charger_price, charger_feature, charger_type, status } = req.body;
        const { isValid, errors } = validateFields(req.body, {
            charger_id: ["required"],
            charger_name: ["required"],
            charger_price: ["required"],
            charger_feature: ["required"],
            charger_type: ["required"],
            status: ["required"]
        });
        if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
        // if (!charger_image) return resp.json({ status:0, code: 422, message: 'charger_image is required' });
        
        const charger = await queryDB(`SELECT image FROM portable_charger WHERE charger_id = ?`, [charger_id]);
        if(!charger) return resp.json({status:0, message: "Charger Data can not edit, or invalid charger Id"});
        
        const charger_image = req.files['charger_image'] ? req.files['charger_image'][0].filename : charger.image;

        const updates = { charger_name, charger_price, charger_feature, charger_type, status, image : charger_image };
        const update = await updateRecord('portable_charger', updates, ['charger_id'], [charger_id]);

        deleteFile('charger-images', charger.image);

        return resp.json({
            status: update.affectedRows > 0 ? 1 : 0,
            code: 200,
            message: update.affectedRows > 0 ? ['Charger updated successfully!'] : ['Failed to update. Please try again.'],
        });

    } catch (error) {
        console.log('Something went wrong:', error);
        return resp.status(500).json({ message: 'Something went wrong' });
    }
};

export const deleteCharger = async (req, resp) => {
    try {
        const { charger_id } = req.body; 
        const { isValid, errors } = validateFields(req.body, { charger_id: ["required"] });
        if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

        const charger = await queryDB(`SELECT image FROM portable_charger WHERE charger_id = ?`, [charger_id]);
        if(!charger) return resp.json({status:0, message: "Charger Data can not be deleted, or invalid"});
        
        const [del] = await db.execute(`DELETE FROM portable_charger WHERE charger_id = ?`, [charger_id]);
        deleteFile('charger-images', charger.image);

        return resp.json({
            code:200,
            message: del.affectedRows > 0 ? ['Charger deleted successfully!'] : ['Oops! Something went wrong. Please try again.'],
            status: del.affectedRows > 0 ? 1 : 0
        });
    } catch (err) {
        console.error('Error deleting portable charger', err);
        return resp.json({ status: 0, message: 'Error deleting portable charger' });
    }
};

export const chargerBookingList = async (req, resp) => {
    try {
        const { page_no, booking_id, name, contact, status, start_date, end_date, search_text = '', scheduleFilters } = req.body;

        const { isValid, errors } = validateFields(req.body, {
            page_no : ["required"]
        });
        
        if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

        const params = {
            tableName: 'portable_charger_booking',
            columns: `booking_id, rider_id, rsa_id, charger_id, vehicle_id, service_name, service_price, service_type, user_name, country_code, contact_no, status, 
            (select rsa_name from rsa where rsa.rsa_id = portable_charger_booking.rsa_id) as rsa_name, 
                ${formatDateInQuery(['slot_date'])}, concat(slot_date, " ", slot_time) as slot_time, ${formatDateTimeInQuery(['created_at'])}`,
            sortColumn       : 'slot_date DESC, slot_time ASC',
            sortOrder        : '',
            page_no,
            limit            : 10,
            liveSearchFields : ['booking_id', 'user_name', 'service_name'],
            liveSearchTexts  : [search_text, search_text, search_text],
            whereField       : ['status'],
            whereValue       : ['PNR'],
            whereOperator    : ["!="]
            // searchFields: ['booking_id', 'user_name', 'contact_no', 'status'],
            // searchTexts: [booking_id, name, contact, status]
            // whereField: ['status'],
            // whereValue: [status],
            // whereOperator: ['==']
        };
        if (start_date && end_date) {
            
            // const start = moment(start_date, "YYYY-MM-DD").startOf('day').format("YYYY-MM-DD HH:mm:ss");
            // const end = moment(end_date, "YYYY-MM-DD").endOf('day').format("YYYY-MM-DD HH:mm:ss");
            const startToday = new Date(start_date);
            const startFormattedDate = `${startToday.getFullYear()}-${(startToday.getMonth() + 1).toString()
                .padStart(2, '0')}-${startToday.getDate().toString().padStart(2, '0')}`;
                        
            const givenStartDateTime    = startFormattedDate+' 00:00:01'; // Replace with your datetime string
            const modifiedStartDateTime = moment(givenStartDateTime).subtract(4, 'hours'); // Subtract 4 hours
            const start                 = modifiedStartDateTime.format('YYYY-MM-DD HH:mm:ss')
            
            const endToday = new Date(end_date);
            const formattedEndDate = `${endToday.getFullYear()}-${(endToday.getMonth() + 1).toString()
                .padStart(2, '0')}-${endToday.getDate().toString().padStart(2, '0')}`;
            const end = formattedEndDate+' 19:59:59';

            params.whereField.push('created_at', 'created_at');
            params.whereValue.push(start, end);
            params.whereOperator.push('>=', '<=');
        }
        if (scheduleFilters.start_date && scheduleFilters.end_date) {
          
            const schStart = moment(scheduleFilters.start_date).format("YYYY-MM-DD");
            const schEnd = moment(scheduleFilters.end_date, "YYYY-MM-DD").format("YYYY-MM-DD");
            
            params.whereField.push('slot_date', 'slot_date');
            params.whereValue.push(schStart, schEnd);
            params.whereOperator.push('>=', '<=');
        }
        if(status) {
            params.whereField.push('status');
            params.whereValue.push(status);
            params.whereOperator.push('=');
        }
        const result = await getPaginatedData(params);

        // const [slotData] = await db.execute(`SELECT slot_id, start_time, end_time, booking_limit FROM portable_charger_slot WHERE status = ?`, [1]);

        return resp.json({
            status: 1,
            code: 200,
            message: ["Portable Charger Booking List fetched successfully!"],
            data: result.data,
            // slot_data: slotData,
            total_page: result.totalPage,
            total: result.total,
            base_url: `${req.protocol}://${req.get('host')}/uploads/offer/`,
        });
    } catch (error) {
        console.error('Error fetching charger booking list:', error);
        return resp.status(500).json({ status: 0, message: 'Error fetching charger booking lists' });
    }
};

export const chargerBookingDetails = async (req, resp) => {
    try {
        const { booking_id } = req.body;

        if (!booking_id) {
            return resp.status(400).json({
                status: 0,
                code: 400,
                message: 'Booking ID is required.',
            });
        }
        const [bookingResult] = await db.execute(`
            SELECT 
                booking_id, rider_id, ${formatDateTimeInQuery(['created_at'])}, user_name, country_code, contact_no, status, address, latitude,
                longitude, service_name, service_price, service_type, service_feature, ${formatDateInQuery(['slot_date'])}, slot_time,
                
                (select concat(rsa_name, ",", country_code, "-", mobile) from rsa where rsa.rsa_id = portable_charger_booking.rsa_id) as rsa_data, 
                (select concat(vehicle_model, "-", vehicle_make) from riders_vehicles as rv where rv.vehicle_id = portable_charger_booking.vehicle_id) as vehicle_data,
                (select pod_name from pod_devices as pd where pd.pod_id = portable_charger_booking.pod_id) as pod_name,
                (select count(*) from portable_charger_booking as pcb where pcb.rider_id = portable_charger_booking.rider_id and pcb.booking_id != portable_charger_booking.booking_id) as cust_booking_count
            FROM 
                portable_charger_booking 
            WHERE 
                booking_id = ?`, 
            [booking_id]
        ); //
        if (bookingResult.length === 0) {
            return resp.status(404).json({
                status: 0,
                code: 404,
                message: 'Booking not found.',
            });
        } // invoice_url
        const [bookingHistory] = await db.execute(`
            SELECT 
                order_status, cancel_by, cancel_reason as reason, rsa_id, ${formatDateTimeInQuery(['created_at'])}, image, remarks,   
                (select rsa.rsa_name from rsa where rsa.rsa_id = portable_charger_history.rsa_id) as rsa_name
            FROM 
                portable_charger_history 
            WHERE 
                booking_id = ?`, 
            [booking_id]
        );
        const bookingDetails = bookingResult[0];
        const history = bookingHistory
        // if (bookingDetails.status == 'PU') {
        //     const invoice_id = bookingDetails.booking_id.replace('PCB', 'INVPC');
        //     bookingDetails.invoice_url = `${req.protocol}://${req.get('host')}/public/portable-charger-invoice/${invoice_id}-invoice.pdf`;
        // }
        bookingDetails.imageUrl = `${req.protocol}://${req.get('host')}/uploads/portable-charger/`;
        return resp.json({
            status  : 1,
            code    : 200,
            message : ["Booking details fetched successfully!"],
            data : {
                booking: bookingDetails,
                history
            }, 
        });
    } catch (error) {
        console.error('Error fetching booking details:', error);
        return resp.status(500).json({ 
            status: 0, 
            code: 500, 
            message: 'Error fetching booking details' 
        });
    }
};
export const chargerBookingDetailsOld = async (req, resp) => {
    try {
        const { booking_id } = req.body;

        if (!booking_id) {
            return resp.status(400).json({
                status: 0,
                code: 400,
                message: 'Booking ID is required.',
            });
        }

        const [bookingResult] = await db.execute(`
            SELECT 
                booking_id, rider_id, rsa_id, charger_id, vehicle_id, 
                service_name, service_price, service_type, service_feature, user_name, 
                contact_no, address,  slot_date, slot_time, status, ${formatDateTimeInQuery(['created_at'])} 
            FROM 
                portable_charger_booking 
            WHERE 
                booking_id = ?`, 
            [booking_id]
        );

        if (bookingResult.length === 0) {
            return resp.status(404).json({
                status: 0,
                code: 404,
                message: 'Booking not found.',
            });
        }

        const bookingDetails = bookingResult[0];
        if (bookingDetails.status == 'PU') {
            const invoice_id = bookingDetails.booking_id.replace('PCB', 'INVPC');
            bookingDetails.invoice_url = `${req.protocol}://${req.get('host')}/public/portable-charger-invoice/${invoice_id}-invoice.pdf`;
        }

        const [history] = await db.execute(`SELECT * FROM portable_charger_history WHERE booking_id = ?`, [booking_id]);

        const [vehicleResult] = await db.execute(`
            SELECT 
                vehicle_id, vehicle_type, vehicle_model
            FROM 
                riders_vehicles 
            WHERE 
                vehicle_id = ?`, 
            [bookingDetails.vehicle_id]
        );
        const bookingHistory = history

        const vehicleDetails = vehicleResult[0]

        const [riderResult] = await db.execute(`
            SELECT 
                rider_id, rider_name, rider_email, rider_mobile, 
                country_code, date_of_birth 
            FROM 
                riders 
            WHERE 
                rider_id = ?`, 
            [bookingDetails.rider_id]
        );

        if (riderResult.length === 0) {
            return resp.status(404).json({
                status: 0,
                code: 404,
                message: 'Rider not found.',
            });
        }

        const riderDetails = riderResult[0];

        const [driverResult] = await db.execute(`
            SELECT 
                rsa_id, rsa_name, email, country_code, 
                mobile, booking_type 
            FROM 
                rsa 
            WHERE 
                rsa_id = ?`, 
            [bookingDetails.rsa_id]
        );
        const driverDetails = driverResult[0];


        return resp.json({
            status: 1,
            code: 200,
            message: ["Booking details fetched successfully!"],
            data: {
                booking: bookingDetails,
                bookingHistory: bookingHistory,
                rider: riderDetails,
                driver: driverDetails,
                vehicle: vehicleDetails
            }, 
        });
    } catch (error) {
        console.error('Error fetching booking details:', error);
        return resp.status(500).json({ 
            status: 0, 
            code: 500, 
            message: 'Error fetching booking details' 
        });
    }
};



/* Invoice */
export const invoiceList = async (req, resp) => {
    try {
        const { page_no, start_date, end_date, search_text } = req.body;

        const { isValid, errors } = validateFields(req.body, {
            page_no: ["required"]
        });

        if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

        const whereFields = [];
        const whereValues = [];
        const whereOperators = [];

        if (start_date && end_date) {
            const startToday = new Date(start_date);
            const startFormattedDate = `${startToday.getFullYear()}-${(startToday.getMonth() + 1).toString()
                .padStart(2, '0')}-${startToday.getDate().toString().padStart(2, '0')}`;
                        
            const givenStartDateTime    = startFormattedDate+' 00:00:01'; // Replace with your datetime string
            const modifiedStartDateTime = moment(givenStartDateTime).subtract(4, 'hours'); // Subtract 4 hours
            const start        = modifiedStartDateTime.format('YYYY-MM-DD HH:mm:ss')
            
            const endToday = new Date(end_date);
            const formattedEndDate = `${endToday.getFullYear()}-${(endToday.getMonth() + 1).toString()
                .padStart(2, '0')}-${endToday.getDate().toString().padStart(2, '0')}`;
            const end = formattedEndDate+' 19:59:59';
    
            whereFields.push('created_at', 'created_at');
            whereValues.push(start, end);
            whereOperators.push('>=', '<=');
        }

        const result = await getPaginatedData({
            tableName: 'portable_charger_invoice',
            columns: `invoice_id, amount, payment_status, invoice_date, currency, 
                (select concat(user_name, ",", country_code, "-", contact_no) from portable_charger_booking as pcb where pcb.booking_id = portable_charger_invoice.request_id limit 1)
                AS riderDetails`,
            sortColumn: 'invoice_date',
            sortOrder: 'DESC',
            page_no,
            limit: 10,
            liveSearchFields: ['invoice_id'],
            liveSearchTexts: [search_text],
            whereField: whereFields,
            whereValue: whereValues,
            whereOperator: whereOperators
        });

        // const [slotData] = await db.execute(`SELECT slot_id, start_time, end_time, booking_limit FROM portable_charger_slot WHERE status = ?`, [1]);

        return resp.json({
            status: 1,
            code: 200,
            message: ["Portable Charger Invoice List fetched successfully!"],
            data: result.data,
            total_page: result.totalPage,
            total: result.total,
            base_url: `${req.protocol}://${req.get('host')}/uploads/offer/`,
        });
    } catch (error) {
        console.error('Error fetching invoice list:', error);
        return resp.status(500).json({ status: 0, message: 'Error fetching invoice lists' });
    }
};

export const invoiceDetails = async (req, resp) => {
    const { invoice_id } = req.body;
    const { isValid, errors } = validateFields(req.body, { invoice_id: ["required"] });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    // amount AS price, payment_status, payment_type, pcb.country_code, pcb.contact_no, pcb.address, 
    // ${formatDateInQuery(['pcb.slot_date'])}, ${formatDateTimeInQuery(['pcb.created_at'])},
    // (SELECT rider_email FROM riders AS rd WHERE rd.rider_id = pci.rider_id) AS rider_email,
    const data = await queryDB(`
        SELECT 
            invoice_id, invoice_date, currency, 
            pcb.user_name, pcb.booking_id, 
            pcb.start_charging_level, pcb.end_charging_level,
            (SELECT coupan_percentage FROM coupon_usage WHERE booking_id = pci.request_id) AS discount
        FROM 
            portable_charger_invoice AS pci 
        LEFT JOIN 
            portable_charger_booking AS pcb ON pcb.booking_id = pci.request_id
        WHERE pci.invoice_id = ?
    `, [invoice_id]);

    data.invoice_url = `${req.protocol}://${req.get('host')}/uploads/portable-charger-invoice/${invoice_id}-invoice.pdf`;

    const chargingLevels = ['start_charging_level', 'end_charging_level'].map(key => 
        data[key] ? data[key].split(',').map(Number) : []
    );
    const chargingLevelSum = chargingLevels[0].reduce((sum, startLevel, index) => sum + (startLevel - chargingLevels[1][index]), 0);
    
    data.kw           = chargingLevelSum * 0.25;
    data.kw_dewa_amt  = data.kw * 0.44;
    data.kw_cpo_amt   = data.kw * 0.26;
    data.delv_charge  = (30 - (data.kw_dewa_amt + data.kw_cpo_amt) ); //when start accepting payment
    data.t_vat_amt    = ( (data.kw_dewa_amt + data.kw_cpo_amt  + data.delv_charge )  * 5) / 100 ;
    data.price        = data.kw_dewa_amt + data.kw_cpo_amt + data.delv_charge;
    data.dis_price    = 0;
    if(data.discount > 0){
        const dis_price = ( data.price * data.discount ) /100
        const total_amt = (data.price - dis_price) ? (data.price - dis_price) : 0;

        data.dis_price  = dis_price ;
        data.t_vat_amt  = Math.floor(( total_amt ) * 5) / 100; 
        data.price      = total_amt + data.t_vat_amt;
    } else {
        data.price      = data.kw_dewa_amt + data.kw_cpo_amt + data.delv_charge + data.t_vat_amt;
    }
    return resp.json({
        message : ["Portable Charger Invoice Details fetched successfully!"],
        data    : data,
        status  : 1,
        code    : 200,
    });
};

/* Slot */
export const slotList = async (req, resp) => {
    try {
        const { page_no,  search_text = '', start_date, end_date} = req.body;

        const { isValid, errors } = validateFields(req.body, {
            page_no: ["required"]
        });

        if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
        let slot_date = moment().format("YYYY-MM-DD"); // ${formatDateInQuery([('slot_date')])} timing

        const params = {
            tableName  : 'portable_charger_slot',
            columns    : `slot_id, slot_date, start_time, end_time, booking_limit, status, 

                (SELECT COUNT(id) FROM portable_charger_booking AS pod WHERE pod.slot_time=portable_charger_slot.start_time AND pod.slot_date=portable_charger_slot.slot_date AND status NOT IN ("PU", "C", "RO")) AS slot_booking_count
            `,
            sortColumn : 'slot_date DESC, start_time ASC',
            sortOrder  : '',
            page_no,
            limit      : 10,
            liveSearchFields: ['slot_id',],
            liveSearchTexts: [search_text,],
            // searchFields: ['added_from', 'emirates'],
            // searchTexts: [addedFrom, emirates],
            whereField: [],
            whereValue: [],
            whereOperator: []
        };
        if (start_date && end_date) {
            const start = moment(start_date, "YYYY-MM-DD").format("YYYY-MM-DD");
            const end = moment(end_date, "YYYY-MM-DD").format("YYYY-MM-DD");

            params.whereField.push('slot_date', 'slot_date');
            params.whereValue.push(start, end);
            params.whereOperator.push('>=', '<=');
        }
        const result = await getPaginatedData(params);

        // const [slotData] = await db.execute(`SELECT slot_id, start_time, end_time, booking_limit FROM portable_charger_slot WHERE status = ?`, [1]);
        const formattedData = result.data.map((item) => ({
            slot_id            : item.slot_id,
            slot_date          : moment(item.slot_date, "DD-MM-YYYY").format('YYYY-MM-DD'),
            booking_limit      : item.booking_limit,
            status             : item.status,
            slot_booking_count : item.slot_booking_count,
            timing             : `${item.start_time} - ${item.end_time}`
        }));
        return resp.json({
            status: 1,
            code: 200,
            message: ["Portable Charger Slot List fetched successfully!"],
            // data: result.data,
            data: formattedData,
            total_page: result.totalPage,
            total: result.total,
            // base_url: `${req.protocol}://${req.get('host')}/uploads/offer/`,
        });
    } catch (error) {
        console.error('Error fetching slot list:', error);
        return resp.status(500).json({ status: 0, message: 'Error fetching charger lists' });
    }
};

export const slotDetails = async (req, resp) => {
    try {
        const { slot_id, slot_date} = req.body;
        const { isValid, errors } = validateFields(req.body, {slot_date: ["required"] });
        if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

        let slotDate = moment().format("YYYY-MM-DD");
        const [slotDetails] = await db.execute(`
            SELECT 
                id, slot_id,  start_time, end_time, booking_limit, status, 
                (SELECT COUNT(id) FROM portable_charger_booking AS pod WHERE pod.slot=portable_charger_slot.slot_id AND pod.slot_date=portable_charger_slot.slot_date AND status NOT IN ("PU", "C")) AS slot_booking_count,
                ${formatDateInQuery(['slot_date'])}
            FROM 
                portable_charger_slot 
            WHERE 
                slot_date = ?`, 
            [slot_date]
        );

        return resp.json({
            status: 1,
            code: 200,
            message: ["Portable Charger Slot Details fetched successfully!"],
            data: slotDetails,
            
        });
    } catch (error) {
        console.error('Error fetching slot list:', error);
        return resp.status(500).json({ status: 0, message: 'Error fetching charger lists' });
    }
};

export const addSlot = async (req, resp) => {
    try {
        const { slot_date, start_time, end_time, booking_limit, status = 1 } = req.body;
        const { isValid, errors } = validateFields(req.body, { slot_date: ["required"], start_time: ["required"], end_time: ["required"], booking_limit: ["required"], });
        if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
        
        if ( !Array.isArray(start_time) || !Array.isArray(end_time) || !Array.isArray(booking_limit) || !Array.isArray(status)) {
            return resp.json({ status: 0, code: 422, message: 'Input data must be in array format.' });
        }
        if ( start_time.length !== end_time.length || end_time.length !== booking_limit.length || booking_limit.length !== status.length) {
            return resp.json({ status: 0, code: 422, message: 'All input arrays must have the same length.' });
        }

        const values = []; const placeholders = [];
        const fSlotDate = moment(slot_date, "DD-MM-YYYY").format("YYYY-MM-DD");
        for (let i = 0; i < start_time.length; i++) {            
            const slotId = `PTS${generateUniqueId({ length:6 })}`;
            values.push(slotId, fSlotDate, convertTo24HourFormat(start_time[i]), convertTo24HourFormat(end_time[i]), booking_limit[i], status[i]);
            placeholders.push('(?, ?, ?, ?, ?, ?)');
        }
        
        const query = `INSERT INTO portable_charger_slot (slot_id, slot_date, start_time, end_time, booking_limit, status) VALUES ${placeholders.join(', ')}`;
        const [insert] = await db.execute(query, values);
        
        return resp.json({
            code: 200,
            message: insert.affectedRows > 0 ? ['Slots added successfully!'] : ['Oops! Something went wrong. Please try again.'],
            status: insert.affectedRows > 0 ? 1 : 0
        });
    } catch (error) {
        console.error('Something went wrong:', error);
        resp.status(500).json({ message: 'Something went wrong' });
    }
};

export const editSlot = asyncHandler(async (req, resp) => {
    const { slot_id, slot_date, start_time, end_time, booking_limit, status } = req.body;
    const { isValid, errors } = validateFields(req.body, {
        slot_id       : ["required"],
        slot_date     : ["required"],
        start_time    : ["required"],
        end_time      : ["required"],
        booking_limit : ["required"],
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    if (!Array.isArray(slot_id) || !Array.isArray(start_time) || !Array.isArray(end_time) || !Array.isArray(booking_limit) || !Array.isArray(status)
    ) {
        return resp.json({ status: 0, code: 422, message: "Input data must be in array format." });
    }
    if (
        start_time.length !== end_time.length || end_time.length !== booking_limit.length || booking_limit.length !== status.length
    ) {
        return resp.json({ status: 0, code: 422, message: "All input arrays must have the same length." });
    }

    let fSlotDate = moment(slot_date, "DD-MM-YYYY").format("YYYY-MM-DD");
    let errMsg = [];

    //  Fetch existing slots for the given date
    const [existingSlots] = await db.execute("SELECT slot_id FROM portable_charger_slot WHERE slot_date = ?",[fSlotDate]);
    const existingSlotIds = existingSlots.map((slot) => slot.slot_id);

    // Determine slots to delete
    const slotsToDelete = existingSlotIds.filter((id) => !slot_id.includes(id));

    //Delete slots that are no longer needed
    for (let id of slotsToDelete) {
        const [deleteResult] = await db.execute("DELETE FROM portable_charger_slot WHERE slot_id = ?", [id] );

        if (deleteResult.affectedRows === 0) {
            errMsg.push(`Failed to delete slot with id ${id}.`);
        }
    }

    // Update or insert slots
    for (let i = 0; i < start_time.length; i++) {
        const updates = {
            slot_date: fSlotDate,
            start_time: convertTo24HourFormat(start_time[i]),
            end_time: convertTo24HourFormat(end_time[i]),
            booking_limit: booking_limit[i],
            status: status[i],
        };

        if (slot_id[i]) {
            // Update existing slot
            const [updateResult] = await db.execute(`UPDATE portable_charger_slot SET start_time = ?, end_time = ?, booking_limit = ?, status = ? 
                  WHERE slot_id = ? AND slot_date = ?`,
                [
                    updates.start_time,
                    updates.end_time,
                    updates.booking_limit,
                    updates.status,
                    slot_id[i],
                    fSlotDate,
                ]
            );
            if (updateResult.affectedRows === 0)
                errMsg.push(`Failed to update ${start_time[i]} for slot_date ${fSlotDate}.`);
        } else {
            // Insert new slot
            const newSlotId = `PST${generateUniqueId({ length: 6 })}`;
            const [insertResult] = await db.execute(`INSERT INTO portable_charger_slot (slot_id, slot_date, start_time, end_time, booking_limit, status)  VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    newSlotId,
                    fSlotDate,
                    updates.start_time,
                    updates.end_time,
                    updates.booking_limit,
                    updates.status,
                ]
            );
            if (insertResult.affectedRows === 0)
                errMsg.push(`Failed to add ${start_time[i]} for slot_date ${fSlotDate}.`);
        }
    }

    if (errMsg.length > 0) {
        return resp.json({ status: 0, code: 400, message: errMsg.join(" | ") });
    }

    return resp.json({ code: 200, message: "Slots updated successfully!", status: 1 });
});

export const deleteSlot = async (req, resp) => {
    try {
        const { slot_date } = req.body; 
        console.log('slot_date',req.body.slot_date);
        

        const { isValid, errors } = validateFields(req.body, {
            slot_date: ["required"]
        });

        if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

        const [del] = await db.execute(`DELETE FROM portable_charger_slot WHERE slot_date = ?`, [slot_date]);

        return resp.json({
            code: 200,
            message: del.affectedRows > 0 ? ['Time Slot deleted successfully!'] : ['Oops! Something went wrong. Please try again.'],
            status: del.affectedRows > 0 ? 1 : 0
        });
    } catch (err) {
        console.error('Error deleting time slot', err);
        return resp.json({ status: 0, message: 'Error deleting time slot' });
    }
}

/* Assign Booking */
export const assignBooking = async (req, resp) => {
    const {  rsa_id, booking_id  } = mergeParam(req);
    const { isValid, errors }      = validateFields(mergeParam(req), {
        rsa_id     : ["required"],
        booking_id : ["required"],
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
    const conn = await startTransaction();
    
    try{ 
        const booking_data = await queryDB( `SELECT rider_id, rsa_id, slot_date, slot_time, (select fcm_token from riders as r where r.rider_id = portable_charger_booking.rider_id ) as fcm_token FROM portable_charger_booking WHERE booking_id = ?
        `, [booking_id ] );
    
        if (!booking_data) {
            return resp.json({ message: `Sorry no booking found with this booking id ${booking_id}`, status: 0, code: 404 });
        }
        const rsa = await queryDB(`SELECT rsa_name, email, fcm_token FROM rsa WHERE rsa_id = ?`, [rsa_id]);
        if(rsa_id == booking_data.rsa_id) {
            return resp.json({ message: `The booking is already assigned to Driver Name ${rsa.rsa_name}. Would you like to assign it to another driver?`, status: 0, code: 404 });
        }
        const slotDateTime = moment(booking_data.slot_date).format('YYYY-MM-DD') +' '+ booking_data.slot_time;
        await insertRecord('portable_charger_booking_assign', 
            ['order_id', 'rsa_id', 'rider_id', 'slot_date_time', 'status'], [booking_id, rsa_id, booking_data.rider_id, slotDateTime, 0], conn
        );
        await conn.execute(`DELETE FROM portable_charger_booking_assign WHERE order_id = ? AND rsa_id = ?`, [booking_id, booking_data.rsa_id]);
        await updateRecord('portable_charger_booking', {rsa_id: rsa_id}, ['booking_id'], [booking_id], conn);
       
        const href    = 'portable_charger_booking/' + booking_id;
        const heading = 'Booking Assigned!';
        const desc    = `Your POD Booking has been assigned to Driver by PlusX admin with booking id : ${booking_id}`;
        createNotification(heading, desc, 'Portable Charging Booking', 'Rider', 'Admin', '', booking_data.rider_id, href);
        pushNotification(booking_data.fcm_token, heading, desc, 'RDRFCM', href);

        const heading1 = 'Portable Charger Booking';
        const desc1    = `A Booking of the portable charging booking has been assigned to you with booking id :  ${booking_id}`;
        createNotification(heading, desc1, 'Portable Charger', 'RSA', 'Rider', booking_data.rider_id, rsa_id, href);
        pushNotification(rsa.fcm_token, heading1, desc1, 'RSAFCM', href);

        const htmlDriver = `<html>
            <body>
                <h4>Dear ${rsa.rsa_name},</h4>
                <p>A Booking of the portable charging booking has been assigned to you.</p> 
                <p>Booking Details:</p>
                Booking ID: ${booking_id}<br>
                Date and Time of Service: ${slotDateTime}<br>        
                <p> Best regards,<br/>PlusX Electric Team </p>
            </body>
        </html>`;
        emailQueue.addEmail(rsa.email, 'PlusX Electric App: Booking Confirmation for Your Portable EV Charger', htmlDriver);
        
        await commitTransaction(conn);
        return resp.json({
            status  : 1, 
            code    : 200,
            message : "You have successfully assigned POD booking." 
        });

    } catch(err){
        await rollbackTransaction(conn);
        console.error("Transaction failed:", err);
        return resp.status(500).json({status: 0, code: 500, message: "Oops! There is something went wrong! Please Try Again" });
    }finally{
        if (conn) conn.release();
    }
};

/* Subscription */
export const subscriptionList = asyncHandler(async (req, resp) => {
    const { page_no, start_date, end_date, search_text = '' } = req.body;

    const whereFields = []
    const whereValues = []
    const whereOperators = []

    if (start_date && end_date) {
        const start = moment(start_date, "YYYY-MM-DD").format("YYYY-MM-DD");
        const end = moment(end_date, "YYYY-MM-DD").format("YYYY-MM-DD");

        whereFields.push('expiry_date', 'expiry_date');
        whereValues.push(start, end);
        whereOperators.push('>=', '<=');
    }

    const result = await getPaginatedData({
        tableName: 'portable_charger_subscriptions',
        // columns: `subscription_id, amount, expiry_date, booking_limit, total_booking, payment_date,
        //     (select concat(rider_name, ",", country_code, "-", rider_mobile) from riders as r where r.rider_id = portable_charger_subscriptions.rider_id) as riderDetails
        // `,
        columns: `
        subscription_id, 
        amount, 
        expiry_date, 
        booking_limit, 
        total_booking, 
        payment_date,
        (SELECT rider_name FROM riders AS r WHERE r.rider_id = portable_charger_subscriptions.rider_id LIMIT 1) AS rider_name,
        (SELECT country_code FROM riders AS r WHERE r.rider_id = portable_charger_subscriptions.rider_id LIMIT 1) AS country_code,
        (SELECT rider_mobile FROM riders AS r WHERE r.rider_id = portable_charger_subscriptions.rider_id LIMIT 1) AS rider_mobile
    `,
        sortColumn: 'id',
        sortOrder: 'DESC',
        liveSearchFields: ['subscription_id'],
        liveSearchTexts: [search_text],
        page_no,
        limit: 10,
        whereField: whereFields,
        whereValue: whereValues,
        whereOperator: whereOperators
    });

    return resp.json({
        status: 1,
        code: 200,
        message: "Subscription List fetch successfully!",
        data: result.data,
        total_page: result.totalPage,
        total: result.total,
    });    
});

export const subscriptionDetail = asyncHandler(async (req, resp) => {
    const { subscription_id } = req.body;
    if (!subscription_id) return resp.json({ status: 0, code: 422, message: "Subscription Id is required" });

    const subscription = await queryDB(`
        SELECT 
          pcs.subscription_id, 
          pcs.amount, 
          pcs.expiry_date, 
          pcs.booking_limit, 
          pcs.total_booking, 
          pcs.payment_date,
          r.rider_name,
          r.country_code,
          r.rider_mobile,
          ${formatDateTimeInQuery(['pcs.created_at'])}
        FROM 
          portable_charger_subscriptions pcs
        JOIN 
          riders r ON r.rider_id = pcs.rider_id
        WHERE 
          pcs.subscription_id = ?
    `, [subscription_id]);
      

    return resp.status(200).json({status: 1, code: 200, data: subscription, message: "Subscription Detail fetch successfully!"});
});


/* Admin Cancel Booking */
export const adminCancelPCBooking = asyncHandler(async (req, resp) => {
    const { rider_id, booking_id, reason } = req.body;
    const { isValid, errors } = validateFields(req.body, {rider_id: ["required"], booking_id: ["required"], reason: ["required"]});
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const checkOrder = await queryDB(`
        SELECT 
            rsa_id, address, slot_date, slot_time, user_name, 
            concat( country_code, "-", contact_no) as contact_no, 
            (SELECT rd.rider_email FROM riders AS rd WHERE rd.rider_id = portable_charger_booking.rider_id) AS rider_email,
            (select fcm_token from riders as r where r.rider_id = portable_charger_booking.rider_id ) as fcm_token, 
            (select fcm_token from rsa where rsa.rsa_id = portable_charger_booking.rsa_id ) as rsa_fcm_token
        FROM 
            portable_charger_booking
        WHERE 
            booking_id = ? AND rider_id = ? AND status IN ('CNF','A','ER') 
        LIMIT 1
    `,[booking_id, rider_id]);

    if (!checkOrder) {
        return resp.json({ message: [`Sorry no booking found with this booking id ${booking_id}`], status: 0, code: 404 });
    }
    const insert = await db.execute(
        'INSERT INTO portable_charger_history (booking_id, rider_id, order_status, rsa_id, cancel_by, cancel_reason) VALUES (?, ?, "C", ?, "Admin", ?)',
        [booking_id, rider_id, checkOrder.rsa_id, reason]
    );
    if(insert.affectedRows == 0) return resp.json({ message: ['Oops! Something went wrong! Please Try Again'], status: 0, code: 200 });

    await updateRecord('portable_charger_booking', {status : 'C'}, ['booking_id'], [booking_id]);
    const href    = `portable_charger_booking/${booking_id}`;
    const title   = 'Portable Charger Cancel!';
    const message = `We regret to inform you that your portable charging booking (ID: ${booking_id}) has been cancelled by the admin.`;
    await createNotification(title, message, 'Portable Charging', 'Rider', 'Rider',  rider_id, rider_id, href);
    await pushNotification(checkOrder.fcm_token, title, message, 'RDRFCM', href);

    if(checkOrder.rsa_id) {
        await db.execute(`DELETE FROM portable_charger_booking_assign WHERE order_id=? AND rider_id=?`, [booking_id, rider_id]);
        await db.execute('UPDATE rsa SET running_order = running_order - 1 WHERE rsa_id = ?', [checkOrder.rsa_id]);

        const message1 = `A Booking of the portable charging booking has been cancelled by admin with booking id : ${booking_id}`;
        await createNotification(title, message1, 'Portable Charging', 'RSA', 'Rider', rider_id, checkOrder.rsa_id,  href);
        await pushNotification(checkOrder.rsa_fcm_token, title, message1, 'RSAFCM', href);
    } 

    const html = `<html>
        <body>
            <h4>Dear ${checkOrder.user_name},</h4>
            <p>We would like to inform you that your recent booking for the Portable EV Charger Service with PlusX Electric has been cancelled.</p><br />
            <p>Booking Details:</p><br />
            <p>Booking ID    : ${booking_id}</p>
            <p>Date and Time : ${checkOrder.slot_date} - ${checkOrder.slot_time}</p>
            <p>Location      : ${checkOrder.address}</p> <br />
            <p>If you have any questions or wish to reschedule your booking, please don't hesitate to reach out to us through the PlusX Electric app or by contacting our support team.</p>
            <p>Thank you for choosing PlusX Electric. We look forward to serving you again in the future.</p><br />
            <p>Best regards,<br/> The PlusX Electric Team </p>
        </body>
    </html>`;
    emailQueue.addEmail(checkOrder.rider_email, `Booking Cancellation Confirmation - PlusX Electric Portable Charger Service (Booking ID : ${booking_id} )`, html);

    const adminHtml = `<html>
        <body>
            <h4>Dear Admin,</h4>
            <p>This is to inform you that admin has cancelled a booking for the Portable EV Charging Service. Please see the details below for record-keeping and any necessary follow-up.</p> <br />
            <p>Booking Details:</p><br />
            <p>User Name    : ${checkOrder.user_name}</p>
            <p>User Contact    : ${checkOrder.contact_no}</p>
            <p>Booking ID    : ${booking_id}</p>
            <p>Scheduled Date and Time : ${checkOrder.slot_date} - ${checkOrder.slot_time}</p> 
            <p>Location      : ${checkOrder.address}</p> <br />
            <p>Thank you for your attention to this update.</p><br />
            <p>Best regards,<br/> The PlusX Electric Team </p>
        </body>
    </html>`;
    emailQueue.addEmail(process.env.MAIL_POD_ADMIN, `Portable Charger Service Booking Cancellation ( :Booking ID : ${booking_id} )`, adminHtml);

    return resp.json({ message: ['Booking has been cancelled successfully!'], status: 1, code: 200 });
});
export const customerChargerBookingList = async (req, resp) => {
    try {
        const { page_no, customerId, status, start_date, end_date, search_text = '', scheduleFilters } = req.body;

        const { isValid, errors } = validateFields(req.body, {
            customerId : ["required"],
            page_no : ["required"]
        });
        
        if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

        const params = {
            tableName: 'portable_charger_booking',
            columns: `booking_id, rider_id, rsa_id, charger_id, vehicle_id, service_name, service_price, service_type, user_name, country_code, contact_no, status, 
            (select rsa_name from rsa where rsa.rsa_id = portable_charger_booking.rsa_id) as rsa_name, 
                ${formatDateInQuery(['slot_date'])}, concat(slot_date, " ", slot_time) as slot_time, ${formatDateTimeInQuery(['created_at'])}`,
            sortColumn : 'slot_date',
            sortOrder  : 'DESC',
            page_no,
            limit: 10,
            liveSearchFields : ['booking_id', 'user_name', 'service_name'],
            liveSearchTexts  : [search_text, search_text, search_text],
            whereField       : [],
            whereValue       : [],
            whereOperator    : [],
            // searchFields: ['booking_id', 'user_name', 'contact_no', 'status'],
            // searchTexts: [booking_id, name, contact, status]
            whereField      : ['rider_id'],
            whereValue      : [customerId],
            whereOperator   : ['=']
        };
        if (start_date && end_date) {
            
            const startToday = new Date(start_date);
            const startFormattedDate = `${startToday.getFullYear()}-${(startToday.getMonth() + 1).toString()
                .padStart(2, '0')}-${startToday.getDate().toString().padStart(2, '0')}`;
                       
            const givenStartDateTime    = startFormattedDate+' 00:00:01'; // Replace with your datetime string
            const modifiedStartDateTime = moment(givenStartDateTime).subtract(4, 'hours'); // Subtract 4 hours
            const start        = modifiedStartDateTime.format('YYYY-MM-DD HH:mm:ss')
            
            const endToday = new Date(end_date);
            const formattedEndDate = `${endToday.getFullYear()}-${(endToday.getMonth() + 1).toString()
                .padStart(2, '0')}-${endToday.getDate().toString().padStart(2, '0')}`;
            const end = formattedEndDate+' 19:59:59';

            params.whereField.push('created_at', 'created_at');
            params.whereValue.push(start, end);
            params.whereOperator.push('>=', '<=');
        }
        if (scheduleFilters.start_date && scheduleFilters.end_date) {
          
            const schStart = moment(scheduleFilters.start_date).format("YYYY-MM-DD");
            const schEnd = moment(scheduleFilters.end_date, "YYYY-MM-DD").format("YYYY-MM-DD");
            
            params.whereField.push('slot_date', 'slot_date');
            params.whereValue.push(schStart, schEnd);
            params.whereOperator.push('>=', '<=');
        }
        if(status) {
            params.whereField.push('status');
            params.whereValue.push(status);
            params.whereOperator.push('=');
        }
        const result = await getPaginatedData(params);

        return resp.json({
            status     : 1,
            code       : 200,
            message    : ["Customer POD Booking List fetched successfully!"],
            data       : result.data,
            total_page : result.totalPage,
            total      : result.total,
        });
    } catch (error) {
        console.error('Error fetching charger booking list:', error);
        return resp.status(500).json({ status: 0, message: 'Error fetching charger booking lists' });
    }
};
export const failedChargerBookingList = async (req, resp) => {
    try {
        const { page_no, start_date, end_date, search_text = '', scheduleFilters } = req.body;

        const { isValid, errors } = validateFields(req.body, {
            page_no : ["required"]
        });
        if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

        const params = {
            tableName : 'portable_charger_booking',
            columns   : `booking_id, rider_id, rsa_id, charger_id, vehicle_id, service_name, service_price, service_type, user_name, country_code, contact_no, status, 
            (select rsa_name from rsa where rsa.rsa_id = portable_charger_booking.rsa_id) as rsa_name, 
                ${formatDateInQuery(['slot_date'])}, concat(slot_date, " ", slot_time) as slot_time, ${formatDateTimeInQuery(['created_at'])}`,
            sortColumn : 'slot_date',
            sortOrder  : 'DESC',
            page_no,
            limit: 10,
            liveSearchFields : ['booking_id', 'user_name', 'service_name'],
            liveSearchTexts  : [search_text, search_text, search_text],
            whereField       : [],
            whereValue       : [],
            whereOperator    : [],          
            whereField       : ['status'],
            whereValue       : ['PNR'],
            whereOperator    : ['=']
        };
        if (start_date && end_date) {
            
            const startToday = new Date(start_date);
            const startFormattedDate = `${startToday.getFullYear()}-${(startToday.getMonth() + 1).toString()
                .padStart(2, '0')}-${startToday.getDate().toString().padStart(2, '0')}`;
                       
            const givenStartDateTime    = startFormattedDate+' 00:00:01'; // Replace with your datetime string
            const modifiedStartDateTime = moment(givenStartDateTime).subtract(4, 'hours'); // Subtract 4 hours
            const start        = modifiedStartDateTime.format('YYYY-MM-DD HH:mm:ss')
            
            const endToday = new Date(end_date);
            const formattedEndDate = `${endToday.getFullYear()}-${(endToday.getMonth() + 1).toString()
                .padStart(2, '0')}-${endToday.getDate().toString().padStart(2, '0')}`;
            const end = formattedEndDate+' 19:59:59';

            params.whereField.push('created_at', 'created_at');
            params.whereValue.push(start, end);
            params.whereOperator.push('>=', '<=');
        }
        if (scheduleFilters.start_date && scheduleFilters.end_date) {
          
            const schStart = moment(scheduleFilters.start_date).format("YYYY-MM-DD");
            const schEnd   = moment(scheduleFilters.end_date, "YYYY-MM-DD").format("YYYY-MM-DD");
            
            params.whereField.push('slot_date', 'slot_date');
            params.whereValue.push(schStart, schEnd);
            params.whereOperator.push('>=', '<=');
        }
        const result = await getPaginatedData(params);

        return resp.json({
            status     : 1,
            code       : 200,
            message    : ["Failed POD Booking List fetched successfully!"],
            data       : result.data,
            total_page : result.totalPage,
            total      : result.total,
        });
    } catch (error) {
        console.error('Error fetching charger booking list:', error);
        return resp.status(500).json({ status: 0, message: 'Error fetching charger booking lists' });
    }
};


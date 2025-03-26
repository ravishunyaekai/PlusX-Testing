import db from '../../config/db.js';
import dotenv from 'dotenv';
import validateFields from "../../validation.js";
import {  getPaginatedData, queryDB, updateRecord } from '../../dbUtils.js';
import { asyncHandler,mergeParam, formatDateTimeInQuery } from '../../utils.js';
import path from 'path';
import moment from 'moment';
import { fileURLToPath } from 'url';
import fs from 'fs';
dotenv.config();


export const getDashboardData = async (req, resp) => {
    try {
        const today = new Date();
        const formattedDate = `${today.getFullYear()}-${(today.getMonth() + 1).toString()
            .padStart(2, '0')}-${today.getDate().toString().padStart(2, '0')}`;
        
        const givenDateTime    = formattedDate+' 00:00:01'; // Replace with your datetime string
        const modifiedDateTime = moment(givenDateTime).subtract(4, 'hours'); // Subtract 4 hours
        const currentDate      = modifiedDateTime.format('YYYY-MM-DD HH:mm:ss');
        const [counts] = await db.execute(`
            SELECT 
                (SELECT COUNT(*) FROM riders WHERE created_at >= "${currentDate}") AS total_rider,
                (SELECT COUNT(*) FROM rsa) AS total_rsa,
                (SELECT COUNT(*) FROM portable_charger_booking WHERE created_at >= "${currentDate}") AS total_charger_booking,
                (SELECT COUNT(*) FROM charging_service WHERE created_at >= "${currentDate}") AS total_charging_service,
                (SELECT COUNT(*) FROM road_assistance WHERE created_at >= "${currentDate}") AS total_road_assistance,
                (SELECT COUNT(*) FROM charging_installation_service WHERE created_at >= "${currentDate}") AS total_installation,
                (SELECT COUNT(*) FROM ev_pre_sale_testing WHERE created_at >= "${currentDate}") AS total_pre_sale_testing,
                (SELECT COUNT(*) FROM public_charging_station_list) AS total_station
        `);

        const [rsaRecords] = await db.execute(`SELECT id, rsa_id, rsa_name, email, country_code, mobile, status, latitude AS lat, longitude AS lng FROM rsa where latitude != '' and status In(1, 2)`);
        const [podRecords] = await db.execute(`SELECT id, pod_id, device_id, pod_name, status, charging_status, latitude AS lat, longitude AS lng FROM pod_devices where latitude != ''`);

        const location = rsaRecords.map((rsa, i) => ({
            key         : rsa.rsa_id,
            rsaId       : rsa.rsa_id,
            rsaName     : rsa.rsa_name,
            email       : rsa.email,
            countryCode : rsa.country_code,
            mobile      : rsa.mobile,
            status      : rsa.status,
            location    : { lat: parseFloat(rsa.lat), lng: parseFloat(rsa.lng) },
        }));

        const podLocation = podRecords.map((pod, i) => ({
            podId           : pod.pod_id,
            deviceId        : pod.device_id,
            podName         : pod.pod_name,
            status          : pod.status,
            charging_status : pod.charging_status,
            location        : { lat: parseFloat(pod.lat), lng: parseFloat(pod.lng) },
        }));

        const count_arr = [ 
            { module: 'App Sign Up', count: counts[0].total_rider },
            { module: 'POD Bookings', count: counts[0].total_charger_booking },
            { module: 'Pickup & Dropoff Bookings', count: counts[0].total_charging_service },
            { module: 'Charger Installation Bookings', count: counts[0].total_installation },
            { module: 'EV Road Assistance', count: counts[0].total_road_assistance },
            { module: 'Pre-Sale Testing Bookings', count: counts[0].total_pre_sale_testing },
            { module: 'No. of Regs. Drivers', count: counts[0].total_rsa },
            { module: 'Total Public Chargers', count: counts[0].total_station }, 

            // { module: 'EV Buy & Sell', count: counts[0].total_vehicle_sell },
            // { module: 'Total Electric Bikes Leasing', count: counts[0].total_bike_rental }, 
            // { module: 'Total Electric Cars Leasing', count: counts[0].total_car_rental },
            // { module: 'Total EV Guide', count: counts[0].total_vehicle }, 
            // { module: 'Total EV Rider Clubs', count: counts[0].total_clubs },
            // { module: 'Total EV Discussion Board', count: counts[0].total_disscussion },
            // { module: 'Total EV Insurance', count: counts[0].total_insurance }, 
            // { module: 'Total EV Specialized Shop', count: counts[0].total_service_shops },
            // { module: 'Total Active Offer', count: counts[0].total_offer },  
            // { module: 'Total Register your Interest', count: counts[0].total_pod }
        ];
        // return resp.json({code: 200, data:count_arr});
        return resp.json({code: 200, data:{count_arr, location, podLocation}});
    } catch (error) {
        console.error('Error fetching dashboard data:', error);
        resp.status(500).json({ message: 'Error fetching dashboard data' });
    }
};

export const notificationList = asyncHandler(async (req, resp) => {
    const { page_no, getCount } = mergeParam(req);
    const { isValid, errors }   = validateFields(mergeParam(req), { page_no: ["required"],});

    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const limit = 10;
    const start = parseInt((page_no * limit) - limit, 10);

    const totalRows  = await queryDB(`SELECT COUNT(*) AS total FROM notifications WHERE panel_to = ? and status = '0' `, ['Admin']);
    if(getCount){
        return resp.json({ 
            status : 1, 
            code       : 200, 
            message    : "Notification Count Only", 
            data       : [], 
            total_page : 0, 
            totalRows  : totalRows.total
        });
    }
    const total_page = Math.ceil(totalRows.total / limit) || 1; 
    const [rows] = await db.execute(`SELECT id, heading, description, module_name, panel_to, panel_from, receive_id, status, ${formatDateTimeInQuery(['created_at'])}, href_url
        FROM notifications WHERE panel_to = 'Admin' ORDER BY id DESC LIMIT ${start}, ${parseInt(limit)} 
    `, []);
    
    const notifications = rows;  // and status = 0 
    await db.execute(`UPDATE notifications SET status=? WHERE status=? AND panel_to=?`, ['1', '0', 'Admin']);
    
    return resp.json({ 
        status     : 1, 
        code       : 200, 
        message    : "Notification list fetch successfully", 
        data       : notifications, 
        total_page : total_page, 
        totalRows  : totalRows.total
    });
});

export const riderList = async (req, resp) => {
    let { page_no, sortBy, addedFrom, emirates, start_date, end_date, search_text = '' } = req.body;

    page_no = parseInt(page_no, 10);
    if (isNaN(page_no) || page_no < 1) {
        page_no = 1;
    }

    const sortOrder = sortBy === 'd' ? 'DESC' : 'ASC';

    try {
        const params = {
            tableName: 'riders',
            columns: `rider_id, rider_name, rider_email, country_code, rider_mobile, emirates, profile_img, vehicle_type, status, ${formatDateTimeInQuery(['created_at', 'updated_at'])}`,
            sortColumn: 'id',
            sortOrder : "DESC",
            page_no : page_no,
            limit: 10,
            liveSearchFields: ['rider_name', 'rider_id', 'rider_email', 'rider_mobile',],
            liveSearchTexts: [search_text, search_text, search_text, search_text,],
            whereField: [],
            whereValue: [],
            whereOperator: []
        };
        if (start_date && end_date) {
            // const start = moment(start_date, "YYYY-MM-DD").startOf('day').format("YYYY-MM-DD HH:mm:ss");
            // const end = moment(end_date, "YYYY-MM-DD").endOf('day').format("YYYY-MM-DD HH:mm:ss");
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
        if(addedFrom) {
            params.whereField.push('added_from');
            params.whereValue.push(addedFrom);
            params.whereOperator.push('=');
        }
        if(emirates) {
            params.whereField.push('emirates');
            params.whereValue.push(emirates);
            params.whereOperator.push('=');
        }

        const result = await getPaginatedData(params);
        const [emiratesResult] = await db.query('SELECT DISTINCT emirates FROM riders');
        

        return resp.json({
            status: 1,
            code: 200,
            message: ["Rider list fetched successfully!"],
            data: result.data,
            emirates: emiratesResult,
            total_page: result.totalPage,
            total: result.total,
        });
    } catch (error) {
        console.error('Error fetching rider list:', error);
        return resp.status(500).json({
            status: 0,
            code: 500,
            message: 'Error fetching rider list',
        });
    }
};

export const riderDetails = async (req, resp) => {
    const { riderId } = req.body;

    if (!riderId) {
        return resp.status(400).json({
            status: 0,
            code: 400,
            message: 'Rider ID is required'
        });
    }

    try {
        const [rows] = await db.execute(
            `SELECT r.*, 
                    ra.address_id, ra.street_name, ra.emirate, ra.area, ra.building_name, ra.unit_no, ra.landmark, ra.nick_name, ra.latitude, ra.longitude, 
                    rv.vehicle_id, rv.vehicle_type, rv.vehicle_number, rv.vehicle_code, rv.year_manufacture, rv.vehicle_model, rv.vehicle_make, rv.leased_from,
                    rv.owner, rv.owner_type, rv.vehicle_specification, rv.emirates
             FROM riders r
             LEFT JOIN rider_address ra ON r.rider_id = ra.rider_id
             LEFT JOIN riders_vehicles rv ON r.rider_id = rv.rider_id
             WHERE r.rider_id = ?`, 
            [riderId]
        );

        if (rows.length === 0) {
            return resp.status(404).json({
                status: 0,
                code: 404,
                message: 'Rider not found'
            });
        }

        const [chargerRows] = await db.execute(
            `SELECT 
                pcb.booking_id, pcb.rsa_id, rsa.rsa_name, pcb.charger_id, pcb.vehicle_id, pcb.service_name, pcb.service_price, pcb.service_type, pcb.service_feature, pcb.status, 
                ${formatDateTimeInQuery(['pcb.created_at'])}
             FROM portable_charger_booking pcb
             JOIN rsa ON pcb.rsa_id = rsa.rsa_id
             WHERE pcb.rider_id = ?
             ORDER BY pcb.created_at DESC
             LIMIT 5`, 
            [riderId]
        );


        const [chargingServiceRows] = await db.execute(
            `SELECT 
                cs.request_id, 
                cs.rsa_id, 
                rsa.rsa_name, 
                cs.vehicle_id, 
                cs.price, 
                cs.order_status, 
                ${formatDateTimeInQuery(['cs.created_at'])}
             FROM charging_service cs
             JOIN rsa ON cs.rsa_id = rsa.rsa_id
             WHERE cs.rider_id = ?
             ORDER BY cs.created_at DESC
             LIMIT 5`,
            [riderId]
        );
        

        const rider = {
            rider_id: rows[0].rider_id,
            rider_name: rows[0].rider_name,
            rider_email: rows[0].rider_email,
            rider_mobile: rows[0].rider_mobile,
            country_code: rows[0].country_code,
            date_of_birth: moment(rows[0].date_of_birth).format('YYYY-MM-DD'),
            area: rows[0].area,
            emirates: rows[0].emirates,
            country: rows[0].country,
            vehicle_type: rows[0].vehicle_type,
            riderAddress: [],
            riderVehicles: [],
            portableChargerBookings: chargerRows.map(row => ({
                booking_id: row.booking_id,
                rsa_id: row.rsa_id,
                rsa_name: row.rsa_name,
                charger_id: row.charger_id,
                vehicle_id: row.vehicle_id,
                service_name: row.service_name,
                service_type: row.service_type,
                service_price: row.service_price,
                service_feature: row.service_feature,
                order_status: row.status,
                created_at: row.created_at,
            })),
            pickAndDropBookings: chargingServiceRows.map(row => ({
                request_id: row.request_id,
                rsa_id: row.rsa_id,
                rsa_name: row.rsa_name,
                vehicle_id: row.vehicle_id,
                price: row.price,
                order_status: row.order_status,
                created_at: row.created_at,
            })),
        };

        const uniqueAddressIds = new Set();
        const uniqueVehicleIds = new Set();

        rows.forEach(row => {
            if (row.address_id && !uniqueAddressIds.has(row.address_id)) {
                uniqueAddressIds.add(row.address_id);
                rider.riderAddress.push({
                    rider_address_id: row.address_id,
                    street: row.street_name,
                    emirate: row.emirate,
                    area: row.area,
                    building_name: row.building_name,
                    unit_no: row.unit_no,
                    landmark: row.landmark,
                    nick_name: row.nick_name,
                    latitude: row.latitude,
                    longitude: row.longitude,
                });
            }

            if (row.vehicle_id && !uniqueVehicleIds.has(row.vehicle_id)) {
                uniqueVehicleIds.add(row.vehicle_id);
                rider.riderVehicles.push({
                    vehicle_id: row.vehicle_id,
                    vehicle_type: row.vehicle_type,
                    vehicle_number: row.vehicle_number,
                    vehicle_code: row.vehicle_code,
                    year_manufacture: row.year_manufacture,
                    vehicle_model: row.vehicle_model,
                    vehicle_make: row.vehicle_make,
                    leased_from: row.leased_from,
                    owner: row.owner,
                    owner_type: row.owner_type,
                    vehicle_specification: row.vehicle_specification,
                    emirates: row.emirates,
                });
            }
        });

        return resp.json({
            status: 1,
            code: 200,
            data: rider
        });
    } catch (error) {
        console.error('Error fetching rider details:', error);
        return resp.status(500).json({
            status: 0,
            code: 500,
            message: 'Error fetching rider details',
        });
    }
};

export const deleteRider = async (req, resp) => {
    const {rider_id} = req.body 
    if (!rider_id) return resp.json({ status: 0, code: 422, message: "Rider ID is required" });

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();
        
        const [rider] = await connection.execute('SELECT profile_img FROM riders WHERE rider_id = ?', [rider_id]);
        if (rider.length === 0) return resp.json({ status: 0, message: 'Rider not found.' });

        const oldImagePath = path.join('uploads', 'rider_profile', rider[0].profile_img || '');
        
        // fs.unlink(oldImagePath, (err) => {
        //     if (err) {
        //         console.error(`Failed to delete rider old image: ${oldImagePath}`, err);
        //     }
        // });

        const deleteQueries = [
            'DELETE FROM notifications                         WHERE receive_id = ?',
            'DELETE FROM road_assistance                       WHERE rider_id   = ?',
            'DELETE FROM order_assign                          WHERE rider_id   = ?',
            'DELETE FROM order_history                         WHERE rider_id   = ?',
            'DELETE FROM charging_installation_service         WHERE rider_id   = ?',
            'DELETE FROM charging_installation_service_history WHERE rider_id   = ?',
            'DELETE FROM charging_service                      WHERE rider_id   = ?',
            'DELETE FROM charging_service_history              WHERE rider_id   = ?',
            'DELETE FROM portable_charger_booking              WHERE rider_id   = ?',
            'DELETE FROM portable_charger_history              WHERE rider_id   = ?',
            'DELETE FROM discussion_board                      WHERE rider_id   = ?',
            'DELETE FROM board_comment                         WHERE rider_id   = ?',
            'DELETE FROM board_comment_reply                   WHERE rider_id   = ?',
            'DELETE FROM board_likes                           WHERE rider_id   = ?',
            'DELETE FROM board_poll                            WHERE rider_id   = ?',
            'DELETE FROM board_poll_vote                       WHERE rider_id   = ?',
            'DELETE FROM board_share                           WHERE sender_id  = ?',
            'DELETE FROM board_views                           WHERE rider_id   = ?',
            'DELETE FROM riders                                WHERE rider_id   = ?'
        ];

        // Execute each delete query
        for (const query of deleteQueries) {
            await connection.execute(query, [rider_id]);
        }

        await connection.commit();

        return resp.json({ status: 1, code: 200, error: false, message: ['Rider account deleted successfully!'] });
    } catch (err) {
        await connection.rollback();
        console.error('Error deleting rider account:', err.message);
        return resp.json({ status: 1, code: 500, error: true, message: ['Something went wrong. Please try again!'] });
    } finally {
        connection.release();
    }
};

//admin profile
export const profileDetails = async (req, resp) => {
    const { email, userId } = req.body;

    if (!userId) {
        return resp.status(400).json({
            status: 0,
            code: 400,
            message: 'User ID is required'
        });
    }

    try {
        const [user] = (await db.execute('SELECT * FROM users WHERE email=? and id = ?', [email, userId]));

        resp.status(200).json({
            message:"Profile Details",
            code: 200, 
            userDetails: user[0], 
            base_url: `${req.protocol}://${req.get('host')}/uploads/profile-image/`,
        })
       
    } catch (error) {
        console.error('Error fetching profile details:', error);
        return resp.status(500).json({
            status: 0,
            code: 500,
            message: 'Error fetching profile details',
        });
    }
};

export const profileUpdate = asyncHandler(async (req, resp) => {
    const{ user_id, name, email, phone, } = req.body;
    const { isValid, errors } = validateFields(req.body, { 
        user_id : ["required"],
        name    : ["required"],
        email   : ["required"],
        phone   : ["required"],
    });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
   
    const [users] = await db.execute('SELECT * FROM users WHERE email = ?', [email]);
      
      if (users.length === 0) {
          return resp.status(404).json({ message: "Entered email is not registered with us, try with another one." });
      }
    const profile_image = req.files['profile_image'] ? files['profile_image'][0].filename : users[0].image;
    const updates       = { name, email, phone, image: profile_image};

    // if(password) updates.password = await bcrypt.hash(password, 10);

    const update = await updateRecord('users', updates, ['email'], [email]);

    if(userData.image) deleteFile('profile-image', users[0].image);

    return resp.json({
        status: update.affectedRows > 0 ? 1 : 0, 
        code: 200, 
        message: update.affectedRows > 0 ? "Profile updated successfully" : "Failed to update, Please Try Again!", 
    });
});

















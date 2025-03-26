import generateUniqueId from 'generate-unique-id';
import db from '../../config/db.js';
import { getPaginatedData, insertRecord, queryDB, updateRecord } from '../../dbUtils.js';
import validateFields from "../../validation.js";
import moment from 'moment';
import { deleteFile, asyncHandler, formatDateTimeInQuery, formatDateInQuery } from '../../utils.js';

export const offerList = asyncHandler(async (req, resp) => {
    const { start_date, end_date, search_text = '', page_no } = req.body;

    const whereFields = []
    const whereValues = []
    const whereOperators = []

    if (start_date && end_date) {
        const start = moment(start_date, "YYYY-MM-DD").format("YYYY-MM-DD");
        const end = moment(end_date, "YYYY-MM-DD").format("YYYY-MM-DD");

        whereFields.push('offer_exp_date', 'offer_exp_date');
        whereValues.push(start, end);
        whereOperators.push('>=', '<=');
    }

    const result = await getPaginatedData({
        tableName: 'offer',
        columns: `offer_id, offer_name, ${formatDateInQuery(['offer_exp_date'])}, offer_image, status`,
        liveSearchFields: ['offer_id', 'offer_name' ],
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
        message: "Offer List fetch successfully!",
        data: result.data,
        total_page: result.totalPage,
        total: result.total,
    });    
});

export const offerDetail = asyncHandler(async (req, resp) => {
    const { offer_id } = req.body;
    if (!offer_id) return resp.json({ status: 0, code: 422, message: "Offer Id is required" });
    
    const offer = await queryDB(`SELECT *, ${formatDateInQuery(['offer_exp_date'])} ,${formatDateTimeInQuery(['created_at', 'updated_at'])} FROM offer WHERE offer_id = ?`, [offer_id]);

    return resp.status(200).json({status: 1, data: offer, message: "Offer Data fetch successfully!"});
});

export const offerAdd = asyncHandler(async (req, resp) => {
    const { offer_name, expiry_date, offer_url } = req.body;
    const { isValid, errors } = validateFields(req.body, { offer_name: ["required"], expiry_date: ["required"] });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });
    let offerImg = '';
    if(req.files && req.files['offer_image']) offerImg = req.files ? req.files['offer_image'][0].filename : '';

    const insert = await insertRecord('offer', [
        'offer_id', 'offer_name', 'offer_exp_date', 'offer_url', 'offer_image', 'status', 
    ], [
        `OFR${generateUniqueId({ length:6 })}`, offer_name, moment(expiry_date, "YYYY-MM-DD").format("YYYY-MM-DD"), offer_url ? offer_url : '', offerImg, 1, 
    ]);

    return resp.json({
        status: insert.affectedRows > 0 ? 1 : 0,
        message: insert.affectedRows > 0 ? "Offer added successfully" : "Failed to insert, Please try again.",
    });
    
});

export const offerEdit = asyncHandler(async (req, resp) => {
    const { offer_id, offer_name, expiry_date, offer_url } = req.body;
    const { isValid, errors } = validateFields(req.body, { offer_id: ["required"], offer_name: ["required"], expiry_date: ["required"] });
    if (!isValid) return resp.json({ status: 0, code: 422, message: errors });

    const offer = await queryDB(`SELECT offer_image FROM offer WHERE offer_id = ?`, [offer_id]);
    if(!offer) return resp.json({ status: 0, code: 422, message: "Offer Data can not edit, or invalid" });

    const fExpiryDate = moment(expiry_date, "YYYY-MM-DD").format("YYYY-MM-DD");
    const updates = {offer_name, offer_exp_date: fExpiryDate, offer_url, };
    if(req.files && req.files['offer_image']) {
        updates.offer_image = req.files ? req.files['offer_image'][0].filename : '';
        deleteFile('offer', offer.offer_image);
    }
    
    const update = await updateRecord('offer', updates, ['offer_id'], [offer_id]);

    return resp.json({
        status: update.affectedRows > 0 ? 1 : 0,
        message: update.affectedRows > 0 ? "Offer updated successfully" : "Failed to update, Please try again.",
    });

});

export const offerDelete = asyncHandler(async (req, resp) => {
    const { offer_id } = req.body;
    if (!offer_id) return resp.json({ status: 0, code: 422, message: "Offer Id is required" });
    
    const offer = await queryDB(`SELECT offer_image FROM offer WHERE offer_id = ?`, [offer_id]);
    if(!offer) return resp.json({ status: 0, code: 422, message: "Invalid Offer Id. Please Try Again." });
    
    deleteFile('offer', offer.offer_image);
    await db.execute(`DELETE FROM offer WHERE offer_id = ?`, [offer_id]);

    return resp.json({ status: 1, code: 200, message: "Offer deleted successfully!" });
});


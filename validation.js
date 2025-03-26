const validateFields = (data, rules) => {
    const errors = {};

    for (const field in rules) {
        const validations = rules[field];
        const value = data[field];

        validations.forEach(rule => {
            switch (rule) {
                case 'required':
                    if (!value) {
                        errors[field] = `${field} is required.`;
                    }
                    break;
                case 'mobile':
                    if (value && !/^\d{10}$/.test(value)) {
                        errors[field] = 'Mobile number must be 10 digits.';
                    }
                    break;
                case 'email':
                    if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
                        errors[field] = 'Invalid email format.';
                    }
                    break;
                case 'password':
                    if (value && value.length < 6) {
                        errors[field] = 'Password must be at least 6 characters.';
                    }
                    break;
                case 'file':
                    if (value) {
                        const allowedTypes = validations[1];
                        const fileExtension = value.split('.').pop().toLowerCase();
                        if (!allowedTypes.includes(fileExtension)) {
                            errors[field] = `File type must be of: ${allowedTypes.join(', ')}.`;
                        }
                    }
                    break;
                default:
                    break;
            }
        });
    }

    return {
        isValid: Object.keys(errors).length === 0,
        errors,
    };
};

export default validateFields;
